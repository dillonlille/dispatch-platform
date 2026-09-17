import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


cache = module("cargo_build", "tooling/cargo-build.py")
prepare = module("pr_prepare", "tooling/pr-prepare.py")
gate = module("ci_gate", "tooling/ci-gate.py")
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

    def test_gate_requires_every_job_and_rejects_failure_cancellation_and_wrong_skips(self):
        jobs = {name: {"result": "success"} for name in ["plan", "build", "core", "collectors", "rust-advisories"]}
        jobs["plan"]["outputs"] = {"mode": "full"}
        self.assertEqual(gate.validate(jobs), "full")
        for name in jobs:
            for result in ["failure", "cancelled", "skipped", ""]:
                with self.subTest(name=name, result=result), self.assertRaises(ValueError):
                    gate.validate({**jobs, name: {**jobs[name], "result": result}})
            with self.assertRaises(ValueError):
                gate.validate({key: value for key, value in jobs.items() if key != name})
        for mode in ["dashboard", "reuse"]:
            lighter = {**jobs, "plan": {"result": "success", "outputs": {"mode": mode}},
                       "core": {"result": "skipped"}, "collectors": {"result": "skipped"}}
            self.assertEqual(gate.validate(lighter), mode)
            with self.assertRaises(ValueError):
                gate.validate({**lighter, "build": {"result": "failure"}})
        with self.assertRaises(ValueError):
            gate.validate({**jobs, "plan": {"result": "success", "outputs": {"mode": "unknown"}}})

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
            key = lambda root, profile="release", compiler="rust-cc", env={}: cache.fingerprint(root, profile, compiler, env)
            first = key(roots[0])
            self.assertEqual(first, key(roots[1]), "Separate worktrees share identical code")
            (roots[1] / "dashboard/main.tsx").write_text("changed UI")
            self.assertEqual(first, key(roots[1]))
            for file in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "backend/src/main.rs",
                         "backend/src/provider.js", "backend/src/schema.sql"]:
                path = roots[1] / file
                original = path.read_text()
                path.write_text(original + "changed")
                self.assertNotEqual(first, key(roots[1]), file)
                path.write_text(original)
            self.assertNotEqual(first, key(roots[1], profile="debug"))
            self.assertNotEqual(first, key(roots[1], compiler="new compiler"))
            self.assertNotEqual(first, key(roots[1], env={"RUSTFLAGS": "custom"}))
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
            "tests/paycom-worker.test.ts", "tests/native-browser.test.ts",
            "tests/cortex-worker.test.ts", "tests/cortex-meals-worker.test.ts",
            "tests/multi-dsp-browser.test.ts", "tests/collection-throughput.test.ts",
        })
        self.assertEqual(set(collectors.SHARDS["capacity"]), {
            "tests/multi-dsp-browser.test.ts", "tests/collection-throughput.test.ts",
        })


if __name__ == "__main__":
    unittest.main()
