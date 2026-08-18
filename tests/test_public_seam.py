from __future__ import annotations

import json
import shutil
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "runner" / "conformance.py"
SOCKET_SCENARIOS = (
    "base-handshake",
    "golden-writing-session",
    "typed-rejections",
    "fatal-fault",
    "reconnect-resumed",
    "reconnect-lost-state",
    "sequence-exhaustion",
    "invalid-server-inputs",
    "markdown-hard-line-breaks",
)


def run_runner(*arguments: str, root: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), "--root", str(root), *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class PublicConformanceSeamTests(unittest.TestCase):
    def test_release_candidate_verifies_offline(self) -> None:
        result = run_runner("verify")

        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["status"], "ok")
        self.assertRegex(summary["artifactDigest"], r"^[0-9a-f]{64}$")
        self.assertRegex(summary["baseArtifactDigest"], r"^[0-9a-f]{64}$")
        self.assertRegex(summary["capabilityRegistryDigest"], r"^[0-9a-f]{64}$")
        self.assertGreaterEqual(summary["jsonPositive"], 1)
        self.assertGreaterEqual(summary["jsonNegative"], 1)
        self.assertGreaterEqual(summary["frameVectors"], 1)
        self.assertGreaterEqual(summary["stateVectors"], 1)

    def test_manifest_detects_a_modified_normative_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "artifact"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            protocol = copy / "spec" / "protocol.md"
            protocol.write_text(protocol.read_text() + "\nchanged\n")

            result = run_runner("verify", root=copy)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("digest mismatch: spec/protocol.md", result.stderr)

    def test_reference_client_passes_the_real_unix_socket_scenario(self) -> None:
        for scenario in SOCKET_SCENARIOS:
            with self.subTest(scenario=scenario):
                result = run_runner(
                    "socket",
                    "--scenario",
                    scenario,
                    "--client",
                    "node",
                    "--no-warnings",
                    "reference/typescript/cli.ts",
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                summary = json.loads(result.stdout)
                self.assertEqual(summary["status"], "ok")
                self.assertEqual(summary["scenario"], scenario)
                self.assertEqual(summary["transport"], "AF_UNIX")

    def test_server_adapter_mode_supplies_a_private_descriptor_directory(self) -> None:
        result = run_runner(
            "server",
            "--scenario",
            "base-handshake",
            "--adapter",
            sys.executable,
            "tests/fake_server_adapter.py",
            "--adapter-flag",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "role": "server",
            "scenario": "base-handshake",
            "status": "ok",
            "transport": "AF_UNIX",
        })

    def test_manifest_rejects_an_unlisted_shipped_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "artifact"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            (copy / "unlisted.txt").write_text("not bound by the manifest\n")

            result = run_runner("verify", root=copy)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unlisted artifact", result.stderr)

    def test_manifest_rejects_relabeling_the_base_digest_scope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "artifact"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            manifest_path = copy / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            protocol_entry = next(
                entry for entry in manifest["artifacts"]
                if entry["path"] == "spec/protocol.md"
            )
            protocol_entry["kind"] = "documentation"
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

            result = run_runner("verify", root=copy)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("incorrect artifact kind", result.stderr)

    def test_manifest_inventory_survives_digest_refresh_and_detects_deleted_case(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "artifact"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            vector_path = copy / "vectors" / "json" / "negative" / "portable-json.json"
            vector = json.loads(vector_path.read_text())
            removed = vector["cases"].pop()["id"]
            vector_path.write_text(json.dumps(vector, indent=2) + "\n")
            regenerated = subprocess.run(
                [sys.executable, str(copy / "runner" / "update_manifest.py")],
                cwd=copy,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(regenerated.returncode, 0, regenerated.stderr)

            result = run_runner("verify", root=copy)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("jsonNegativeCaseIds", result.stderr)
        self.assertIn(removed, json.loads((ROOT / "manifest.json").read_text())["jsonNegativeCaseIds"])

    def test_reference_client_rejects_an_insecure_descriptor_before_connecting(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            os.chmod(directory, 0o700)
            owner_lock = directory / "owner.lock"
            owner_lock.touch(mode=0o600)
            os.chmod(owner_lock, 0o600)
            descriptor = directory / "endpoint.json"
            descriptor.write_text(json.dumps({
                "version": 1,
                "socketPath": str(directory / "missing.sock"),
                "launchToken": "A" * 64,
                "serverEpoch": "epoch",
                "protocolMajor": 1,
                "protocolMinor": 0,
                "pid": 42,
            }))
            os.chmod(descriptor, 0o644)

            result = subprocess.run(
                [
                    "node", str(ROOT / "reference" / "typescript" / "cli.ts"),
                    "--descriptor", str(descriptor), "--scenario", "base-handshake",
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mode 0600", result.stderr)

    def test_reference_client_requires_the_sibling_owner_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            os.chmod(directory, 0o700)
            descriptor = directory / "endpoint.json"
            descriptor.write_text(json.dumps({
                "version": 1,
                "socketPath": str(directory / "missing.sock"),
                "launchToken": "A" * 64,
                "serverEpoch": "epoch",
                "protocolMajor": 1,
                "protocolMinor": 0,
                "pid": 42,
            }))
            os.chmod(descriptor, 0o600)

            result = subprocess.run(
                [
                    "node", str(ROOT / "reference" / "typescript" / "cli.ts"),
                    "--descriptor", str(descriptor), "--scenario", "base-handshake",
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("owner.lock", result.stderr)

    def test_reference_client_validates_descriptor_pid_before_connecting(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            os.chmod(directory, 0o700)
            owner_lock = directory / "owner.lock"
            owner_lock.touch(mode=0o600)
            os.chmod(owner_lock, 0o600)
            descriptor = directory / "endpoint.json"
            descriptor.write_text(json.dumps({
                "version": 1,
                "socketPath": str(directory / "missing.sock"),
                "launchToken": "A" * 64,
                "serverEpoch": "epoch",
                "protocolMajor": 1,
                "protocolMinor": 0,
                "pid": 0,
            }))
            os.chmod(descriptor, 0o600)

            result = subprocess.run(
                [
                    "node", str(ROOT / "reference" / "typescript" / "cli.ts"),
                    "--descriptor", str(descriptor), "--scenario", "base-handshake",
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("descriptor.pid", result.stderr)

    def test_verifier_enforces_unicode_scalar_coordinate_vectors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "artifact"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            vector_path = copy / "vectors" / "state" / "unicode-scalar-coordinates.json"
            vector = json.loads(vector_path.read_text())
            vector["coordinateCases"][0]["valid"] = False
            vector_path.write_text(json.dumps(vector, indent=2) + "\n")
            regenerated = subprocess.run(
                [sys.executable, str(copy / "runner" / "update_manifest.py")],
                cwd=copy,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(regenerated.returncode, 0, regenerated.stderr)

            result = run_runner("verify", root=copy)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("coordinate", result.stderr)


if __name__ == "__main__":
    unittest.main()
