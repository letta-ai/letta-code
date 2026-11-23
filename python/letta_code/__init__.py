"""Launcher for the bundled Letta Code CLI (not a Python API client)."""

import os
import subprocess
import sys
from pathlib import Path


def main():
    payload = Path(__file__).resolve().parent / "_payload"
    node = payload / "bin" / ("node.exe" if os.name == "nt" else "node")
    cli = payload / "app" / "letta.js"
    if not node.is_file() or not cli.is_file():
        raise SystemExit(
            "Incomplete Letta Code installation. Reinstall the letta wheel."
        )
    env = os.environ.copy()
    path_key = next((k for k in env if k.upper() == "PATH"), "PATH")
    env[path_key] = str(node.parent) + os.pathsep + env.get(path_key, "")
    env["LETTA_CODE_DISTRIBUTION"] = "pypi"
    args = [str(node), str(cli), *sys.argv[1:]]
    if os.name != "nt":
        os.execve(node, args, env)
    child = subprocess.Popen(args, env=env)
    try:
        return child.wait()
    except KeyboardInterrupt:
        return child.wait()
