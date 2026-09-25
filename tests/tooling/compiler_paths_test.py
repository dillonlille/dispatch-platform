import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


remap = load("remap", "tooling/rustc-remap.py")
gate = load("build_paths", "tooling/security/check-build-paths.py")


def config(wrapper):
    digest = hashlib.sha256(wrapper.read_bytes()).hexdigest()
    return {"build": {"rustc-wrapper": "tooling/rustc-remap.py",
                      "rustflags": ["--cfg=dispatch_path_policy_" + digest]}}


class CompilerPathTests(unittest.TestCase):
    def test_cargo_fingerprint_tracks_the_current_policy(self):
        self.assertEqual(tomllib.loads((ROOT / ".cargo/config.toml").read_text()),
                         config(ROOT / "tooling/rustc-remap.py"))

    def test_specific_paths_override_home_and_cover_symlink_locations(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "operator"
            cargo = home / "cache with spaces"
            cargo.mkdir(parents=True)
            link = Path(directory) / "linked-cargo"
            link.symlink_to(cargo, target_is_directory=True)
            root = home / "project"
            flags = remap.mappings(root, {"HOME": str(home), "CARGO_HOME": str(link)})
            def mapped(path):
                for flag in reversed(flags):
                    before, after = flag.removeprefix("--remap-path-prefix=").rsplit("=", 1)
                    if str(path).startswith(before):
                        return after + str(path)[len(before):]
                return str(path)
            self.assertEqual(mapped(root / "src/main.rs"), "/dispatch-build/source/src/main.rs")
            self.assertEqual(mapped(cargo / "dependency.rs"), "/dispatch-build/cargo/dependency.rs")
            self.assertEqual(mapped(link / "dependency.rs"), "/dispatch-build/cargo/dependency.rs")
            self.assertEqual(mapped(home / ".rustup/library.rs"), "/dispatch-build/rustup/library.rs")
            self.assertEqual(mapped(home / "other.rs"), "/dispatch-build/home/other.rs")
        with self.assertRaises(ValueError):
            remap.mappings(ROOT, {"HOME": "/"})

    def test_artifact_gate_rejects_home_and_custom_build_paths_without_printing_them(self):
        env = {"HOME": "/private/operator", "CARGO_HOME": "/cache/private-registry"}
        for mapped in [b"/dispatch-build/cargo/registry/a.rs", b"/dispatch-build/home/folder/a.rs"]:
            self.assertFalse(gate.has_build_paths(mapped, "/checkout", env))
        for private in ["/" + "home/operator/src/a.rs", "/" + "home/" + "a" * 32 + "/a.rs",
                        "/" + "Users/operator/a.rs", "/" + "Users/Example Person/a.rs",
                        "C:" + chr(92) + "Users" + chr(92) + "operator", "/cache/private-registry/a.rs",
                        "/checkout/src/main.rs", "/private/operator/a.rs"]:
            self.assertTrue(gate.has_build_paths(private.encode(), "/checkout", env))
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "bad-binary"
            private = "/" + "home/operator/private.rs"
            binary.write_bytes(b"\0" + private.encode())
            result = subprocess.run(["python3", str(ROOT / "tooling/security/check-build-paths.py"), str(binary)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(private, result.stdout + result.stderr)

    def test_adjacent_runtime_literals_are_not_one_compiler_path(self):
        # The backend checks these two directories while verifying browser isolation.
        literals = (b"/home" + b"/root" + b"DISPATCH_STATE_ROOTbrowser_isolation_required"
                    + b"pidnetmntipcutsBrowserOSServerBrowserClawServer" + b"/usr/bin/Xvfb")
        env = {"HOME": "/private/operator"}
        self.assertFalse(gate.has_build_paths(literals, "/checkout", env))
        long_home = "/" + "home/" + "a" * 40
        self.assertTrue(gate.has_build_paths((long_home + "/src/a.rs").encode(),
                                            "/checkout", {"HOME": long_home}))

    def test_real_cargo_remaps_dependencies_and_rebuilds_when_policy_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "checkout"
            dependency = Path(directory) / "private-cargo/registry/dependency"
            for path in [root / "src", root / ".cargo", root / "tooling", dependency / "src"]:
                path.mkdir(parents=True)
            wrapper = root / "tooling/rustc-remap.py"
            shutil.copy2(ROOT / "tooling/rustc-remap.py", wrapper)
            (dependency / "Cargo.toml").write_text('[package]\nname="path-probe"\nversion="0.0.0"\nedition="2024"\n')
            (dependency / "src/lib.rs").write_text('pub fn origin() -> &\'static str { file!() }\n')
            (root / "Cargo.toml").write_text('[package]\nname="compiler-path-probe"\nversion="0.0.0"\nedition="2024"\n'
                                              '[dependencies]\npath-probe={path="../private-cargo/registry/dependency"}\n')
            (root / "src/main.rs").write_text('fn main() { println!("{}", path_probe::origin()); }\n')
            env = {k: v for k, v in os.environ.items() if not k.startswith(("CARGO_", "RUSTFLAGS", "RUSTC"))}
            env["CARGO_HOME"] = str(Path(directory) / "private-cargo")
            binary = root / "target/debug/compiler-path-probe"
            for destination in ["cargo", "updated-cargo"]:
                if destination != "cargo":
                    wrapper.write_text(wrapper.read_text().replace('/dispatch-build/cargo', '/dispatch-build/updated-cargo'))
                flag = config(wrapper)["build"]["rustflags"][0]
                (root / ".cargo/config.toml").write_text('[build]\nrustc-wrapper="tooling/rustc-remap.py"\n'
                                                         f'rustflags=["{flag}"]\n')
                # Starting in a member source directory also checks Cargo's config path resolution.
                result = subprocess.run(["cargo", "build", "--offline"], cwd=root / "src", env=env,
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = subprocess.check_output([str(binary)], text=True).strip()
                self.assertEqual(output, f"/dispatch-build/{destination}/registry/dependency/src/lib.rs")
                self.assertFalse(gate.has_build_paths(binary.read_bytes(), root, env))


if __name__ == "__main__":
    unittest.main()
