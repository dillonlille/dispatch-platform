import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


cache = module("cargo_build", "tooling/cargo-build.py")
prepare = module("pr_prepare", "tooling/ci/pr-prepare.py")
collectors = module("browseros_check", "tooling/browseros-check.py")


class PipelineTests(unittest.TestCase):
    def test_custom_build_inputs_disable_local_binary_reuse(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-cache-policy-") as temp:
            root = Path(temp)
            (root / "backend").mkdir()
            (root / "Cargo.toml").write_text('[workspace]\nmembers = ["backend"]\n')
            (root / "backend/Cargo.toml").write_text('[package]\nname = "fixture"\n')
            # A private empty CARGO_HOME avoids depending on host configuration.
            env = {"CARGO_HOME": str(root / "cargo-home")}
            self.assertTrue(cache.cache_eligible(root, env))
            for override in [{"CI": "true"}, {"DISPATCH_DISABLE_RUST_CACHE": "1"},
                             {"CARGO_TARGET_DIR": "/custom"}, {"RUSTC_WRAPPER": "/wrapper"},
                             {"CARGO_SOURCE_LOCAL_DIRECTORY": "/external"}]:
                self.assertFalse(cache.cache_eligible(root, {**env, **override}))
            (root / "backend/build.rs").write_text("custom build")
            self.assertFalse(cache.cache_eligible(root, env))
            (root / "backend/build.rs").unlink()
            (root / "backend/Cargo.toml").write_text('[dependencies]\nexternal = { path = "../../outside" }\n')
            self.assertFalse(cache.cache_eligible(root, env))
            (root / "Cargo.toml").write_text('[workspace]\nmembers = ["backend", "backend/host"]\n')
            (root / "backend/Cargo.toml").write_text('[dependencies]\ndispatch-host = { path = "host" }\n')
            (root / "backend/host").mkdir()
            host_manifest = root / "backend/host/Cargo.toml"
            host_manifest.write_text('[package]\nname = "dispatch-host"\n')
            self.assertTrue(cache.cache_eligible(root, env))
            (root / "Cargo.toml").write_text('[workspace]\nmembers = ["backend", "backend/host", "backend/ci"]\n')
            (root / "backend/ci").mkdir()
            (root / "backend/ci/Cargo.toml").write_text('[package]\nname = "dispatch-ci"\n')
            host_manifest.write_text('[dependencies]\ndispatch-ci = { path = "../ci" }\n')
            self.assertTrue(cache.cache_eligible(root, env))
            host_manifest.write_text('[dependencies]\nexternal = { path = "../../../outside" }\n')
            self.assertFalse(cache.cache_eligible(root, env))

    def test_ci_binary_reuse_requires_explicit_environment_and_exact_validated_inputs(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-ci-binary-") as temp:
            root = Path(temp)
            (root / "backend/src").mkdir(parents=True)
            (root / "tooling").mkdir()
            (root / "Cargo.toml").write_text('[workspace]\nmembers = ["backend"]\n')
            (root / "backend/Cargo.toml").write_text('[package]\nname = "fixture"\n')
            source = root / "backend/src/main.rs"
            source.write_text("fn main() {}")
            env = {"CI": "true", "CARGO_HOME": str(root / "cargo-home"),
                   "DISPATCH_CI_RUST_CACHE": str(root / ".ci-rust-cache")}
            self.assertFalse(cache.cache_eligible(root, env))
            self.assertTrue(cache.cache_eligible(root, env, allow_ci=True))
            self.assertFalse(cache.ci_cache_enabled(root, {**env, "DISPATCH_CI_RUST_CACHE": "/other"}))
            builds = []
            def compile(args, **_kwargs):
                builds.append(args)
                binary = root / "target/release/dispatch-backend"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_text(source.read_text())
            with patch.dict(cache.os.environ, env, clear=True), \
                    patch.object(cache, "__file__", str(root / "tooling/cargo-build.py")), \
                    patch.object(cache, "output", side_effect=lambda *args, **_kw: str(root / ".git") if args[0] == "git" else "pinned compiler"), \
                    patch.object(cache.subprocess, "run", side_effect=compile):
                cache.build(release=True)
                (root / "target/release/dispatch-backend").unlink()
                cache.build(release=True)
                self.assertEqual(len(builds), 1)
                source.write_text("fn main() { changed(); }")
                cache.build(release=True)
                self.assertEqual(len(builds), 2)
                # An intact cache hit is required even if GitHub restored the key.
                for binary in (root / ".ci-rust-cache").glob("*/dispatch-backend"):
                    binary.write_text("corruption")
                cache.build(release=True)
                self.assertEqual(len(builds), 3)
                with patch.dict(cache.os.environ, {"DISPATCH_CI_RUST_KEY": "wrong key"}), self.assertRaises(RuntimeError):
                    cache.build(release=True)
                self.assertEqual(len(builds), 3)

    def test_local_cache_follows_all_rust_inputs_but_not_dashboard_changes(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-cache-test-") as temp:
            roots = [Path(temp) / name for name in ("one", "two")]
            for root in roots:
                (root / "backend/src").mkdir(parents=True)
                (root / "dashboard").mkdir()
                (root / "Cargo.toml").write_text("workspace")
                (root / "Cargo.lock").write_text("locked")
                (root / "rust-toolchain.toml").write_text("pinned")
                (root / "backend/src/main.rs").write_text("fn main() {}")
                (root / "backend/src/provider.js").write_text("provider")
                (root / "backend/src/schema.sql").write_text("schema")
                (root / "backend/host/src").mkdir(parents=True)
                (root / "backend/host/Cargo.toml").write_text("host manifest")
                (root / "backend/host/src/lib.rs").write_text("host policy")
                (root / "backend/ci/src").mkdir(parents=True)
                (root / "backend/ci/Cargo.toml").write_text("CI manifest")
                (root / "backend/ci/src/lib.rs").write_text("CI policy")
            key = lambda root, profile="release", compiler="rust-cc", env={}: cache.fingerprint(root, profile, compiler, env)
            first = key(roots[0])
            self.assertEqual(first, key(roots[1]), "Separate worktrees share identical code")
            (roots[1] / "dashboard/main.tsx").write_text("changed UI")
            self.assertEqual(first, key(roots[1]))
            for file in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "backend/src/main.rs",
                         "backend/src/provider.js", "backend/src/schema.sql",
                         "backend/host/Cargo.toml", "backend/host/src/lib.rs",
                         "backend/ci/Cargo.toml", "backend/ci/src/lib.rs"]:
                path = roots[1] / file
                original = path.read_text()
                path.write_text(original + "changed")
                self.assertNotEqual(first, key(roots[1]), file)
                path.write_text(original)
            self.assertNotEqual(first, key(roots[1], profile="debug"))
            self.assertNotEqual(first, key(roots[1], compiler="new compiler"))
            self.assertNotEqual(first, key(roots[1], env={"RUSTFLAGS": "custom"}))
            self.assertNotEqual(first, key(roots[1], env={"ImageVersion": "new runner"}))
            (roots[1] / "backend/src/new.rs").write_text("untracked source")
            self.assertNotEqual(first, key(roots[1]))
            (roots[1] / "backend/src/new.rs").unlink()
            (roots[1] / "backend/src/schema.sql").unlink()
            self.assertNotEqual(first, key(roots[1]))

    def test_cached_binary_requires_intact_digest_and_copies_to_private_checkout(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-cache-copy-") as temp:
            root = Path(temp)
            entry = root / "entry"
            entry.mkdir()
            self.assertIsNone(cache.cached_binary(entry))
            binary = entry / "dispatch-backend"
            binary.write_bytes(b"compiled backend")
            (entry / "sha256").write_text(hashlib.sha256(binary.read_bytes()).hexdigest())
            self.assertEqual(cache.cached_binary(entry), binary)
            destination = root / "checkout/target/release/dispatch-backend"
            cache.copy_binary(binary, destination)
            self.assertEqual(destination.read_bytes(), binary.read_bytes())
            self.assertNotEqual(destination.stat().st_ino, binary.stat().st_ino)
            binary.write_bytes(b"corrupted")
            self.assertIsNone(cache.cached_binary(entry))
            self.assertEqual(destination.read_bytes(), b"compiled backend")

    def test_local_cache_keeps_only_recently_used_entries_and_never_the_one_in_use(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-cache-prune-") as temp:
            store = Path(temp)
            for age, key in enumerate(["newest", "newer", "older", "oldest", "current"]):
                (store / key).mkdir()
                (store / key / "dispatch-backend").write_bytes(b"compiled backend")
                (store / (key + ".lock")).touch()
                os.utime(store / key, (1_000_000 - age, 1_000_000 - age))
            (store / "abandoned.lock").touch()
            (store / "building.lock").touch()
            self.assertEqual(cache.stale_entries(store, 3, "current"),
                             ["older", "oldest", "building", "abandoned"])
            # Another worktree is compiling one key and reading another.
            with (store / "building.lock").open("a") as building, (store / "oldest.lock").open("a") as reading:
                fcntl.flock(building, fcntl.LOCK_EX)
                fcntl.flock(reading, fcntl.LOCK_EX)
                # A concurrent pruner can remove an entry between listing and deletion.
                original = cache.stale_entries
                with patch.object(cache, "stale_entries",
                                  side_effect=lambda *args: [*original(*args), "already-removed"]):
                    cache.prune(store, 3, "current")
            self.assertEqual(sorted(item.name for item in store.iterdir()),
                             ["building.lock", "current", "current.lock", "newer", "newer.lock",
                              "newest", "newest.lock", "oldest", "oldest.lock"])
            self.assertEqual((store / "oldest/dispatch-backend").read_bytes(), b"compiled backend")
            cache.prune(store, 3, "current")
            self.assertEqual(sorted(item.name for item in store.iterdir() if item.is_dir()),
                             ["current", "newer", "newest"])
            cache.prune(store, 0, "current")
            self.assertEqual(sorted(item.name for item in store.iterdir()), ["current", "current.lock"])

    def test_lock_on_a_pruned_key_is_taken_again_instead_of_excluding_nobody(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-cache-lock-") as temp:
            root = Path(temp)
            with cache.entry_lock(root, "key") as held:
                self.assertTrue(held)
                with cache.entry_lock(root, "key", wait=False) as second:
                    self.assertFalse(second)
            stale = (root / "key.lock").open("a")
            self.addCleanup(stale.close)
            fcntl.flock(stale, fcntl.LOCK_EX)
            (root / "key.lock").unlink()
            with cache.entry_lock(root, "key", wait=False) as held:
                self.assertTrue(held)
                self.assertTrue((root / "key.lock").exists())

    def test_local_cache_hits_refresh_recency_before_pruning(self):
        with tempfile.TemporaryDirectory(prefix="dispatch-cache-recency-") as temp:
            root = Path(temp)
            (root / "backend/src").mkdir(parents=True)
            (root / "tooling").mkdir()
            (root / ".git").mkdir()
            (root / "Cargo.toml").write_text('[workspace]\nmembers = ["backend"]\n')
            (root / "backend/Cargo.toml").write_text('[package]\nname = "fixture"\n')
            source = root / "backend/src/main.rs"
            builds = []
            def compile(args, **_kwargs):
                builds.append(args)
                binary = root / "target/debug/dispatch-backend"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_text(source.read_text())
            def build(contents, age=None):
                source.write_text(contents)
                before = set((root / ".git/dispatch-rust-builds").glob("*/"))
                cache.build()
                for entry in set((root / ".git/dispatch-rust-builds").glob("*/")) - before if age else []:
                    os.utime(entry, (age, age))
            with patch.dict(cache.os.environ, {"CARGO_HOME": str(root / "cargo-home")}, clear=True), \
                    patch.object(cache, "__file__", str(root / "tooling/cargo-build.py")), \
                    patch.object(cache, "KEEP", 2), \
                    patch.object(cache, "output", side_effect=lambda *args, **_kw: str(root / ".git") if args[0] == "git" else "pinned compiler"), \
                    patch.object(cache.subprocess, "run", side_effect=compile):
                build("first", age=1_000_000)
                build("second", age=2_000_000)
                build("first")
                self.assertEqual(len(builds), 2)
                build("third")
                build("first")
                self.assertEqual(len(builds), 3, "The reused entry outlived the newer unused one")
                build("second")
                self.assertEqual(len(builds), 4)
            entries = [item for item in (root / ".git/dispatch-rust-builds").iterdir() if item.is_dir()]
            self.assertEqual(len(entries), 2)
            self.assertTrue(all(cache.cached_binary(entry) for entry in entries))

    def test_pr_preflight_coordinates_ready_branches_without_blocking_drafts(self):
        draft = {"number": 1, "headRefName": "another", "isDraft": True}
        self.assertEqual(prepare.blockers("feature", False, True, [draft]), [])
        ready = {**draft, "isDraft": False}
        self.assertTrue(prepare.blockers("feature", False, True, [ready]))
        self.assertEqual(prepare.blockers("feature", False, True, [ready], True), [])
        self.assertEqual(prepare.blockers("another", False, True, [ready]), [])
        self.assertTrue(prepare.blockers("dev", False, True, []))
        self.assertTrue(prepare.blockers("feature", True, True, []))
        self.assertTrue(prepare.blockers("feature", False, False, []))

    def test_collector_shards_preserve_coverage_and_isolate_capacity(self):
        files = [file for shard in collectors.SHARDS.values() for file in shard]
        self.assertEqual(len(files), len(set(files)))
        self.assertEqual(set(files), {
            "tests/providers/paycom-worker.test.ts", "tests/providers/native-browser.test.ts",
            "tests/providers/cortex-worker.test.ts", "tests/providers/cortex-meals-worker.test.ts",
            "tests/providers/multi-dsp-browser.test.ts", "tests/providers/collection-throughput.test.ts",
        })
        self.assertEqual(set(collectors.SHARDS["capacity"]), {
            "tests/providers/multi-dsp-browser.test.ts", "tests/providers/collection-throughput.test.ts",
        })


if __name__ == "__main__":
    unittest.main()
