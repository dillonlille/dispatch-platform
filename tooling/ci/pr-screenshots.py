#!/usr/bin/env python3
"""Before-and-after screenshots for a PR: capture them from the fixture server, then publish
them to the repository's `screenshots` branch and print the PR's Screenshots section.

    npm run pr:screenshots -- capture <before|after> <screen>... [--dark]
    npm run pr:screenshots -- publish [--reviewed]

Screens are page ids from `dashboard/src/app/route-meta.ts`. Captures go to the worktree's
scratch directory, `/tmp/dispatch-<worktree>/screenshots/<label>/`. Publishing audits them
with the export privacy check first; the images it has not seen need a visual review, which
`--reviewed` asserts, and are then recorded in the private review manifest.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

LABELS = ("before", "after")
NEEDS_REVIEW = "image-needs-synthetic-data-review"
# The audit also flags every unreviewed binary asset as such; the same review clears both.
REVIEW_RULES = {NEEDS_REVIEW, "asset-needs-synthetic-data-review"}


def run(args, cwd=None, env=None, check=True, capture=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=capture)
    if check and result.returncode:
        raise SystemExit(f"{' '.join(map(str, args[:3]))} failed:\n{(result.stderr or result.stdout or '').strip()}")
    return (result.stdout or "").strip()


class Worktree:
    def __init__(self, root=None):
        self.root = Path(root or run(["git", "rev-parse", "--show-toplevel"])).resolve()
        self.name = self.root.name
        self.scratch = Path(os.environ.get("DISPATCH_SCRATCH") or f"/tmp/dispatch-{self.name}")
        self.shots = self.scratch / "screenshots"
        self.branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=self.root)
        # The workspace holds the worktrees directory and the private `.privacy/` state.
        self.workspace = Path(os.environ.get("DISPATCH_WORKSPACE") or self.root.parent.parent)

    def repository(self):
        url = run(["git", "remote", "get-url", "origin"], cwd=self.root)
        match = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?/?$", url)
        if not match:
            raise SystemExit(f"Cannot read the GitHub repository from the origin URL")
        return match.group(1)


def capture(tree, label, screens, dark):
    if not (tree.root / ".build/release.json").is_file():
        raise SystemExit("Run npm run build first; the screenshots come from the built dashboard.")
    output = tree.shots / label
    if output.exists():
        shutil.rmtree(output)
    env = {**os.environ, "DISPATCH_SCREENSHOTS": ",".join(screens), "DISPATCH_SCREENSHOT_DIR": str(output),
           "DISPATCH_SCREENSHOT_SCHEME": "dark" if dark else "light", "TMPDIR": str(tree.scratch),
           "DISPATCH_TEST_OUTPUT": str(tree.scratch / "test-results")}
    tree.scratch.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(["npm", "run", "test:ui", "--", "tests/browser/screenshots.spec.ts"],
                            cwd=tree.root, env=env)
    if result.returncode:
        raise SystemExit("The capture failed; its output is above.")
    for name in sorted(output.glob("*.png")):
        print(name)


def files(tree):
    """`(label, name, path)` for every capture, in the order the section shows them."""
    found = []
    for label in LABELS:
        directory = tree.shots / label
        if directory.is_dir():
            for path in sorted(directory.glob("*.png")):
                found.append((label, path.name, path))
    if not found:
        raise SystemExit(f"No screenshots under {tree.shots}; capture some first.")
    return found


def titles(tree):
    result = {}
    for label in LABELS:
        index = tree.shots / label / "index.json"
        if index.is_file():
            result.update(json.loads(index.read_text()))
    return result


def audit(tree, staged, review_file, tesseract):
    """The export privacy check over the staged copies; its findings, name to rules."""
    args = [sys.executable, str(tree.root / "tooling/security/exports.py"), "--workspace", str(staged),
            "--review-file", str(review_file)]
    if tesseract:
        args += ["--tesseract", str(tesseract)]
    result = subprocess.run(args, cwd=tree.root, text=True, capture_output=True)
    findings = {}
    for line in (result.stdout + result.stderr).splitlines():
        match = re.fullmatch(r"(\S+):(\d+): (\S+)", line.strip())
        if match:
            findings.setdefault(match.group(1), set()).add(match.group(3))
    if result.returncode and not findings:
        raise SystemExit(f"The export audit could not run:\n{(result.stderr or result.stdout).strip()}")
    return findings


def record(review_file, hashes):
    """Adds the reviewed images' exact hashes to the private manifest, keeping it private."""
    manifest = json.loads(review_file.read_text())
    manifest.setdefault("assets", {}).update(hashes)
    review_file.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    review_file.chmod(0o600)


def sha256(path):
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def section(repository, commit, branch, captured, labels):
    """The PR's Screenshots section: each screen with its before and after, or after alone."""
    screens = {}
    for label, name, _ in captured:
        screens.setdefault(name, {})[label] = (
            f"https://raw.githubusercontent.com/{repository}/{commit}/{branch}/{label}/{name}")
    lines = ["## Screenshots", ""]
    for name, shots in screens.items():
        title = labels.get(name[:-4], name[:-4].replace("-", " ").capitalize())
        lines.append(f"{title}, before and after" if len(shots) == 2 else f"{title}, new")
        for label in LABELS:
            if label in shots:
                lines.append(f"![{title} {label}]({shots[label]})")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def push(tree, branch_name, captured, git_env=None):
    """Commits the captures under `<branch>/<label>/` on the screenshots branch, keeping every
    other PR's directory, and pushes; the commit's hash pins the links."""
    git = lambda *args: run(["git", *args], cwd=tree.root, env={**os.environ, **(git_env or {})})
    for attempt in range(2):
        parent = None
        fetch = subprocess.run(["git", "fetch", "-q", "origin", "refs/heads/screenshots"], cwd=tree.root,
                               text=True, capture_output=True)
        if fetch.returncode == 0:
            parent = git("rev-parse", "FETCH_HEAD")
        with tempfile.TemporaryDirectory(prefix="dispatch-screenshots-") as temporary:
            env = {"GIT_INDEX_FILE": str(Path(temporary) / "index"), **(git_env or {})}
            indexed = lambda *args: run(["git", *args], cwd=tree.root, env={**os.environ, **env})
            if parent:
                indexed("read-tree", parent)
                stale = [name for name in indexed("ls-files").splitlines()
                         if name.startswith(f"{branch_name}/")]
                if stale:
                    indexed("update-index", "--force-remove", *stale)
            for label, name, path in captured:
                blob = git("hash-object", "-w", str(path))
                indexed("update-index", "--add", "--cacheinfo", f"100644,{blob},{branch_name}/{label}/{name}")
            tree_id = indexed("write-tree")
        message = f"screenshots: {branch_name}"
        commit = git("commit-tree", tree_id, *(["-p", parent] if parent else []), "-m", message)
        result = subprocess.run(["git", "push", "-q", "origin", f"{commit}:refs/heads/screenshots"],
                                cwd=tree.root, text=True, capture_output=True)
        if result.returncode == 0:
            return commit
        if attempt:
            raise SystemExit(f"Pushing the screenshots branch failed:\n{result.stderr.strip()}")
    raise AssertionError("unreachable")


def publish(tree, reviewed, review_file=None, tesseract=None, pusher=push, auditor=audit):
    if tree.branch in ("main", "HEAD"):
        raise SystemExit("Publish from the PR's branch, not main.")
    captured = files(tree)
    review_file = review_file or tree.workspace / ".privacy/export-review.json"
    if tesseract is None:
        candidate = tree.workspace / ".privacy/bin/tesseract"
        tesseract = candidate if candidate.is_file() else None
    with tempfile.TemporaryDirectory(prefix="dispatch-screenshots-") as temporary:
        staged = Path(temporary) / "workspace"
        keys = {}
        for label, name, path in captured:
            copy = staged / "screenshots" / tree.branch / label / name
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, copy)
            keys[f"screenshots/{tree.branch}/{label}/{name}"] = path
        findings = auditor(tree, staged, review_file, tesseract)
        unreviewed = {name for name, rules in findings.items() if rules <= REVIEW_RULES}
        other = {name: rules for name, rules in findings.items() if not rules <= REVIEW_RULES}
        if other:
            listed = "\n".join(f"- {name}: {', '.join(sorted(rules))}" for name, rules in sorted(other.items()))
            raise SystemExit(f"The export audit found problems; matching values are withheld:\n{listed}")
        if unreviewed:
            if not reviewed:
                listed = "\n".join(f"- {keys[name]}" for name in sorted(unreviewed))
                raise SystemExit("Look at these images, then publish again with --reviewed to record them "
                                 f"as reviewed synthetic screenshots:\n{listed}")
            record(review_file, {name: sha256(keys[name]) for name in unreviewed})
            if auditor(tree, staged, review_file, tesseract):
                raise SystemExit("The export audit still fails after recording the review.")
    commit = pusher(tree, tree.branch, captured)
    text = section(tree.repository(), commit, tree.branch, captured, titles(tree))
    (tree.shots / "section.md").write_text(text)
    print(text)
    return commit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    cap = commands.add_parser("capture", help="photograph screens into the scratch directory")
    cap.add_argument("label", choices=LABELS)
    cap.add_argument("screens", nargs="+", help="page ids from app/route-meta.ts")
    cap.add_argument("--dark", action="store_true", help="capture the dark color scheme")
    pub = commands.add_parser("publish", help="audit, push to the screenshots branch, print the section")
    pub.add_argument("--reviewed", action="store_true",
                     help="the listed images were looked at and show only fixture data")
    args = parser.parse_args(argv)
    tree = Worktree()
    if args.command == "capture":
        capture(tree, args.label, args.screens, args.dark)
    else:
        publish(tree, args.reviewed)


if __name__ == "__main__":
    main()
