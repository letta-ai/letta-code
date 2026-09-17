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
NODE = "22.19.0"
# Official nodejs.org SHASUMS256.txt; pin the archive, not only the version.
TARGETS = {
    ("Linux", "x86_64"): (
        "linux-x64",
        "manylinux_2_28_x86_64",
        "d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d",
    ),
    ("Linux", "aarch64"): (
        "linux-arm64",
        "manylinux_2_28_aarch64",
        "d32817b937219b8f131a28546035183d79e7fd17a86e38ccb8772901a7cd9009",
    ),
    ("Darwin", "arm64"): (
        "darwin-arm64",
        "macosx_14_0_arm64",
        "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d",
    ),
    ("Darwin", "x86_64"): (
        "darwin-x64",
        "macosx_14_0_x86_64",
        "3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c",
    ),
    ("Windows", "AMD64"): (
        "win-x64",
        "win_amd64",
        "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
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
    pty = app / "node_modules/node-pty"
    if os.name == "nt":
        # node-pty's checked-in Windows prebuild includes its matched ConPTY
        # helpers. A source rebuild on Actions loaded but never reported child
        # exit, leaving conpty.node locked until the runner killed the process.
        prebuild = pty / "prebuilds/win32-x64"
        if not prebuild.is_dir():
            raise SystemExit("node-pty Windows x64 prebuild is missing")
        shutil.rmtree(pty / "build", ignore_errors=True)
        for candidate in (pty / "prebuilds").iterdir():
            if candidate != prebuild:
                shutil.rmtree(candidate)
    else:
        native_env = env.copy()
        native_env["npm_config_build_from_source"] = "true"
        subprocess.run(
            [npm, "rebuild", "node-pty", "--foreground-scripts"],
            cwd=app,
            env=native_env,
            check=True,
        )
        shutil.rmtree(pty / "prebuilds", ignore_errors=True)
    subprocess.run(
        [npm, "rebuild", "@vscode/ripgrep", "--foreground-scripts"],
        cwd=app,
        env=env,
        check=True,
        shell=os.name == "nt",
    )
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
