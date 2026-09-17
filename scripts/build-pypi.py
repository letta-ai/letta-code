"""Build a self-contained letta wheel on its target OS/CPU.

Prerequisites: locked `bun install --frozen-lockfile`, Bun, npm, Python 3.9+,
C/C++ toolchain (node-pty). Run from any directory; artifacts go to python/dist.
Linux release builds MUST run in the manylinux_2_28 CI image, not a newer host.
No upload/publish is performed by this script.
"""

import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = "24.13.0"
# Official nodejs.org SHASUMS256.txt; pin the archive, not only the version.
TARGETS = {
    ("Linux", "x86_64"): (
        "linux-x64",
        "manylinux_2_28_x86_64",
        "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
    ),
    ("Linux", "aarch64"): (
        "linux-arm64",
        "manylinux_2_28_aarch64",
        "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
    ),
    ("Darwin", "arm64"): (
        "darwin-arm64",
        "macosx_14_0_arm64",
        "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
    ),
    ("Darwin", "x86_64"): (
        "darwin-x64",
        "macosx_14_0_x86_64",
        "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
    ),
    ("Windows", "AMD64"): (
        "win-x64",
        "win_amd64",
        "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88",
    ),
}


def run(args, **kwargs):
    # npm.cmd requires a shell on Windows; all arguments here are build-owned.
    if os.name == "nt" and args[0] in ("npm", "bun"):
        args[0] += ".cmd" if args[0] == "npm" else ".exe"
    return subprocess.check_output(args, cwd=ROOT, **kwargs)


def main():
    key = (platform.system(), platform.machine())
    if key not in TARGETS:
        raise SystemExit(f"Unsupported wheel platform: {key[0]} {key[1]}")
    target, wheel_platform, checksum = TARGETS[key]
    if platform.system() == "Linux" and platform.libc_ver()[0] != "glibc":
        raise SystemExit("Only glibc Linux is supported (not musl/Alpine)")
    # Do not falsely label artifacts built on a newer glibc as manylinux_2_28.
    if platform.system() == "Linux" and platform.libc_ver()[1] != "2.28":
        if os.environ.get("LETTA_PYPI_LOCAL_TEST") != "1":
            raise SystemExit(
                "Use the manylinux_2_28 CI image, or LETTA_PYPI_LOCAL_TEST=1 for a non-publishable local wheel"
            )
        wheel_platform = "linux_" + platform.machine()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("PyPI builds currently require a stable X.Y.Z package version")
    payload = ROOT / "python/letta_code/_payload"
    shutil.rmtree(payload, ignore_errors=True)
    (payload / "bin").mkdir(parents=True)
    app = payload / "app"
    app.mkdir()
    extension = "zip" if os.name == "nt" else "tar.gz"
    archive_name = f"node-v{NODE}-{target}.{extension}"
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / archive_name
        urllib.request.urlretrieve(
            f"https://nodejs.org/dist/v{NODE}/{archive_name}", archive
        )
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise SystemExit("Node archive checksum mismatch")
        prefix = f"node-v{NODE}-{target}"
        # Extract only trusted, explicitly named runtime/license files, never npm.
        names = {
            "node.exe" if os.name == "nt" else "bin/node": "bin/node.exe"
            if os.name == "nt"
            else "bin/node",
            "LICENSE": "NODE-LICENSE",
        }
        if extension == "zip":
            with zipfile.ZipFile(archive) as source:
                for member, destination in names.items():
                    (payload / destination).write_bytes(
                        source.read(f"{prefix}/{member}")
                    )
        else:
            with tarfile.open(archive) as source:
                for member, destination in names.items():
                    (payload / destination).write_bytes(
                        source.extractfile(f"{prefix}/{member}").read()
                    )
    node = payload / "bin" / ("node.exe" if os.name == "nt" else "node")
    node.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
    run(["bun", "run", "build"], env=env)
    packed = json.loads(
        run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], env=env)
    )
    for entry in packed[0]["files"]:
        path = entry["path"]
        destination = app / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / path, destination)
    run([str(node), "scripts/stage-pypi-deps.mjs", str(app)], env=env)
    # Native addons must be built with the Node ABI we ship, not Bun/host Node.
    npm = shutil.which("npm")
    native_env = env.copy()
    native_env["npm_config_build_from_source"] = "true"
    subprocess.run(
        [npm, "rebuild", "node-pty", "--foreground-scripts"],
        cwd=app,
        env=native_env,
        check=True,
        shell=os.name == "nt",
    )
    subprocess.run(
        [npm, "rebuild", "@vscode/ripgrep", "--foreground-scripts"],
        cwd=app,
        env=env,
        check=True,
        shell=os.name == "nt",
    )
    pty = app / "node_modules/node-pty"
    shutil.rmtree(pty / "prebuilds", ignore_errors=True)
    for path in ("third_party", "deps", "src", "build/Release/obj.target"):
        shutil.rmtree(pty / path, ignore_errors=True)
    for helper in app.rglob("spawn-helper"):
        helper.chmod(0o755)
    (payload / "manifest.json").write_text(
        json.dumps(
            {
                "version": version,
                "node": NODE,
                "target": target,
                "wheel_platform": wheel_platform,
            },
            indent=2,
        )
        + "\n"
    )
    spec = importlib.util.spec_from_file_location(
        "wheel_backend", ROOT / "python/wheel_backend.py"
    )
    backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)
    print(backend.build_wheel(str(ROOT / "python/dist")))


if __name__ == "__main__":
    main()
