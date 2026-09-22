"""Rust owns cache/preflight policy; test compatibility entry points here."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "tooling"))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


cache = module("cargo_build", "tooling/cargo-build.py")
prepare = module("pr_prepare", "tooling/ci/pr-prepare.py")
collectors = module("browseros_check", "tooling/browseros-check.py")


class PipelineTests(unittest.TestCase):
    def test_build_and_preflight_launchers_preserve_arguments(self):
        for launcher, command, args in [
            (cache, "build", []),
            (cache, "build", ["--release", "--cache-key"]),
            (prepare, "preflight", ["--allow-concurrent"]),
        ]:
            with self.subTest(command=command, args=args), patch.object(launcher, "launch") as launch:
                launcher.main(args)
                launch.assert_called_once_with(command, *args)

    def test_setup_launchers_use_trusted_host_and_preserve_paths_and_owner_names(self):
        args = ["--root", "/private path/dev", "--first-name", "Two Names"]
        for environment in ["dev", "production"]:
            launcher = module(f"setup_{environment}", f"tooling/setup-{environment}.py")
            with patch.object(launcher, "host_binary", return_value=Path("/trusted path/dispatch-host")), \
                    patch.object(launcher.os, "execv") as execute:
                launcher.main(args)
                execute.assert_called_once_with("/trusted path/dispatch-host", [
                    "/trusted path/dispatch-host", "host", "setup", environment, *args])

    def test_collector_shards_preserve_coverage_and_isolate_capacity(self):
        files = [file for shard in collectors.SHARDS.values() for file in shard]
        self.assertEqual(len(files), len(set(files)))
        self.assertEqual(set(files), {
            "tests/providers/paycom-worker.test.ts", "tests/providers/native-browser.test.ts",
            "tests/providers/native-browser-recovery.test.ts",
            "tests/providers/cortex-worker.test.ts", "tests/providers/cortex-meals-worker.test.ts",
            "tests/providers/multi-dsp-browser.test.ts", "tests/providers/collection-throughput.test.ts",
        })
        self.assertEqual(set(collectors.SHARDS["capacity"]), {
            "tests/providers/multi-dsp-browser.test.ts", "tests/providers/collection-throughput.test.ts",
        })


if __name__ == "__main__":
    unittest.main()
