"""Wheel-only backend. Run scripts/build-pypi.py to stage the native payload first.

There is deliberately no sdist: installing must never compile or fetch Node/npm.
The launcher is Python ABI independent, but its payload is platform specific.
"""

import base64
import csv
import hashlib
import io
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    manifest = ROOT / "letta_code" / "_payload" / "manifest.json"
    if not manifest.exists():
        raise RuntimeError("Run scripts/build-pypi.py on the target platform first")
    info = json.loads(manifest.read_text())
    version, platform = info["version"], info["wheel_platform"]
    tag = f"py3-none-{platform}"
    dist = f"letta-{version}.dist-info"
    filename = f"letta-{version}-{tag}.whl"
    output = Path(wheel_directory)
    output.mkdir(parents=True, exist_ok=True)
    records = []
    with zipfile.ZipFile(output / filename, "w", zipfile.ZIP_DEFLATED) as wheel:

        def add(name, data, source=None):
            if source:
                wheel.write(source, name)
            else:
                wheel.writestr(name, data)
            digest = (
                base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                .rstrip(b"=")
                .decode()
            )
            records.append((name, f"sha256={digest}", len(data)))

        for path in sorted((ROOT / "letta_code").rglob("*")):
            if (
                path.is_file()
                and "__pycache__" not in path.parts
                and path.suffix != ".pyc"
            ):
                add(path.relative_to(ROOT).as_posix(), path.read_bytes(), path)
        add(
            f"{dist}/METADATA",
            (
                f"Metadata-Version: 2.4\nName: letta\nVersion: {version}\n"
                "Summary: Letta Code: stateful agents in your terminal\n"
                "Requires-Python: >=3.9\nLicense-Expression: Apache-2.0\n"
                "License-File: LICENSE\n"
                "Project-URL: Documentation, https://docs.letta.com/letta-code\n"
                "Project-URL: Source, https://github.com/letta-ai/letta-code\n"
                "Description-Content-Type: text/markdown\n\n"
                + (ROOT / "README.md").read_text()
            ).encode(),
        )
        add(f"{dist}/licenses/LICENSE", (ROOT.parent / "LICENSE").read_bytes())
        add(
            f"{dist}/WHEEL",
            f"Wheel-Version: 1.0\nGenerator: letta-code\nRoot-Is-Purelib: false\nTag: {tag}\n".encode(),
        )
        add(f"{dist}/entry_points.txt", b"[console_scripts]\nletta = letta_code:main\n")
        record = io.StringIO(newline="")
        csv.writer(record).writerows([*records, (f"{dist}/RECORD", "", "")])
        wheel.writestr(f"{dist}/RECORD", record.getvalue())
    return filename
