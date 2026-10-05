"""Run live Ollama E2E on Modal over Tailscale with bounded resource lifetimes.

Uses two temporary peers, no public ports, and a hard Modal lifetime.
Never prints or persists enrollment keys. Infrastructure tokens stay local.
"""

import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

import modal


def api(method, path, body=None):
    request = urllib.request.Request(
        "https://api.tailscale.com/api/v2/" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + os.environ["TAILSCALE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def enroll(tag):
    return api(
        "POST",
        "tailnet/-/keys",
        {
            "capabilities": {
                "devices": {
                    "create": {
                        "reusable": False,
                        "ephemeral": True,
                        "preauthorized": True,
                        "tags": [tag],
                    }
                }
            },
            "expirySeconds": 600,
            "description": "Temporary Letta Ollama connectivity probe",
        },
    )


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=330, **kwargs)


def main():
    for name in ("TAILSCALE_ACCESS_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"):
        if not os.environ.get(name):
            raise RuntimeError(name + " is required; refusing to skip live coverage")
    prefix = "lc-ollama-probe-" + uuid.uuid4().hex[:10]
    artifacts = Path(os.environ.get("OLLAMA_E2E_ARTIFACTS", ".cache/ollama-e2e"))
    artifacts.mkdir(parents=True, exist_ok=True)
    report = {
        "prefix": prefix,
        "ollama": "0.33.3",
        "tailscale": "1.102.3",
        "gpu": "L4",
        "cpu": 4,
        "memoryMiB": 16384,
        "context": 32768,
        "started": time.time(),
    }
    keys = []
    sandbox = None
    daemon = None
    scenario = None
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    with (
        tempfile.TemporaryDirectory(prefix=prefix) as work,
        open(Path(work) / "tailscaled.log", "w") as log,
    ):
        binary_dir = Path(os.environ.get("TAILSCALE_BIN_DIR", work))
        if not (binary_dir / "tailscale").exists():
            with (
                urllib.request.urlopen(
                    "https://pkgs.tailscale.com/stable/tailscale_1.102.3_amd64.tgz",
                    timeout=60,
                ) as response,
                tarfile.open(
                    fileobj=io.BytesIO(response.read()), mode="r:gz"
                ) as archive,
            ):
                for name in ("tailscale", "tailscaled"):
                    binary = binary_dir / name
                    binary.write_bytes(
                        archive.extractfile("tailscale_1.102.3_amd64/" + name).read()
                    )
                    binary.chmod(0o755)
        socket = str(Path(work) / "tailscaled.sock")
        ts = [str(binary_dir / "tailscale"), "--socket=" + socket]
        try:
            keys.append(enroll("tag:letta-ollama-ci"))
            keys.append(enroll("tag:letta-ollama-server"))
            daemon = subprocess.Popen(
                [
                    str(binary_dir / "tailscaled"),
                    "--tun=userspace-networking",
                    "--state=mem:",
                    "--socket=" + socket,
                    "--outbound-http-proxy-listen=127.0.0.1:11055",
                ],
                stdout=log,
                stderr=log,
            )
            for _ in range(100):
                if Path(socket).exists():
                    break
                time.sleep(0.1)
            run(
                *ts,
                "up",
                "--auth-key=" + "file:/dev/stdin",
                "--hostname=" + prefix + "-ci",
                "--accept-dns=false",
                input=keys[0]["key"],
            )
            print("CI-side temporary peer joined", flush=True)
            image = (
                modal.Image.from_registry("ollama/ollama:0.33.3", add_python="3.12")
                .entrypoint([])
                .apt_install("curl", "ca-certificates")
                .run_commands(
                    "curl -fsSL https://pkgs.tailscale.com/stable/tailscale_1.102.3_amd64.tgz "
                    "| tar xz -C /tmp && cp /tmp/tailscale_1.102.3_amd64/tailscale* /usr/local/bin/"
                )
            )
            app = modal.App.lookup("letta-ollama-e2e", create_if_missing=True)
            volume = modal.Volume.from_name(
                "letta-ollama-e2e-models", create_if_missing=True
            )
            startup = """
set -eu
tailscaled --tun=userspace-networking --state=mem: --socket=/tmp/ts.sock >/tmp/tailscale.log 2>&1 &
for i in $(seq 1 100); do test -S /tmp/ts.sock && break; sleep .1; done
tailscale --socket=/tmp/ts.sock up --auth-key="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false
unset TS_AUTHKEY
ollama serve >/tmp/ollama.log 2>&1 &
for i in $(seq 1 100); do curl -fsS http://127.0.0.1:11434/api/version && break; sleep .2; done
tailscale --socket=/tmp/ts.sock serve --bg --tcp=11434 tcp://127.0.0.1:11434
ollama pull qwen3.5:9b >/tmp/pull.log 2>&1
touch /tmp/ready
wait
"""
            with modal.enable_output():
                sandbox = modal.Sandbox.create(
                    "bash",
                    "-c",
                    startup,
                    app=app,
                    image=image,
                    gpu="L4",
                    cpu=4,
                    memory=16384,
                    timeout=1800,
                    volumes={"/models": volume},
                    # No Modal public ports are configured. A non-loopback
                    # listener permits the tailnet Host header (100.64/10 is
                    # not an RFC1918 address in Ollama's host protection).
                    env={
                        "OLLAMA_HOST": "0.0.0.0:11434",
                        "OLLAMA_MODELS": "/models",
                        "OLLAMA_CONTEXT_LENGTH": "32768",
                        "TS_HOSTNAME": prefix + "-gpu",
                    },
                    secrets=[modal.Secret.from_dict({"TS_AUTHKEY": keys[1]["key"]})],
                )
            print(
                "Modal sandbox:",
                sandbox.object_id,
                "(30-minute hard deadline)",
                flush=True,
            )
            report["sandboxId"] = sandbox.object_id
            (artifacts / "infrastructure.json").write_text(json.dumps(report, indent=2))
            deadline = time.monotonic() + 700
            while time.monotonic() < deadline:
                process = sandbox.exec("test", "-f", "/tmp/ready", timeout=10)
                process.wait()
                if process.returncode == 0:
                    break
                if sandbox.poll() is not None:
                    raise RuntimeError("Modal startup exited: " + sandbox.stderr.read())
                time.sleep(5)
            else:
                raise TimeoutError("Ollama model readiness exceeded 700 seconds")
            proc = sandbox.exec(
                "tailscale", "--socket=/tmp/ts.sock", "ip", "-4", timeout=10
            )
            address = proc.stdout.read().strip()
            print("Ollama ready on temporary peer", address, flush=True)
            connection = run(*ts, "ping", "--c=3", "--until-direct=false", address)
            (artifacts / "tailscale-ping.log").write_text(connection)
            print(connection, flush=True)
            proxy = "http://127.0.0.1:11055"
            tags = run(
                "curl",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--max-time",
                "30",
                "--proxy",
                proxy,
                "http://" + address + ":11434/api/tags",
            )
            (artifacts / "ollama-models.json").write_text(tags)
            if "--cancel-probe" in sys.argv:
                raise KeyboardInterrupt("Intentional cancellation after readiness")
            if "--scenario" in sys.argv or "--tui-only" in sys.argv:
                scenario = subprocess.Popen(
                    ["node", "scripts/ollama-e2e/scenario.cjs"]
                    + (["--tui-only"] if "--tui-only" in sys.argv else []),
                    start_new_session=True,
                    env=dict(
                        os.environ,
                        OLLAMA_BASE_URL="http://" + address + ":11434",
                        OLLAMA_E2E_HTTP_PROXY=proxy,
                    ),
                )
                status = scenario.wait(timeout=1250)
                if status != 0:
                    raise RuntimeError(
                        "CLI scenario failed with exit code " + str(status)
                    )
                return
            started = time.monotonic()
            output = run(
                "curl",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--max-time",
                "300",
                "--proxy",
                proxy,
                "http://" + address + ":11434/api/chat",
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps(
                    {
                        "model": "qwen3.5:9b",
                        "stream": True,
                        "think": False,
                        "messages": [
                            {
                                "role": "user",
                                "content": "Reply with exactly OLLAMA_TAILSCALE_OK",
                            }
                        ],
                    }
                ),
            )
            rows = [json.loads(line) for line in output.splitlines() if line]
            assert rows[-1].get("done") is True, "Stream did not complete"
            text = "".join(row.get("message", {}).get("content", "") for row in rows)
            assert "OLLAMA_TAILSCALE_OK" in text, text
            print(
                "PASS: streamed Qwen inference through Tailscale:",
                text,
                "seconds=",
                round(time.monotonic() - started, 2),
                flush=True,
            )
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            cleanup_errors = []

            def cleanup(label, action):
                try:
                    action()
                except Exception as error:  # noqa: BLE001 - one cleanup failure must not skip the others
                    cleanup_errors.append(label)
                    print("Cleanup failed:", label, type(error).__name__, flush=True)

            if scenario is not None and scenario.poll() is None:
                cleanup(
                    "scenario SIGTERM", lambda: os.killpg(scenario.pid, signal.SIGTERM)
                )
                try:
                    scenario.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    cleanup(
                        "scenario SIGKILL",
                        lambda: os.killpg(scenario.pid, signal.SIGKILL),
                    )
            if sandbox is not None:

                def collect_logs():
                    diagnostics = sandbox.exec(
                        "bash",
                        "-c",
                        "tail -n 35 /tmp/ollama.log; ps -eo pid,pcpu,comm | sort -k2 -nr | head -8",
                        timeout=10,
                    )
                    (artifacts / "ollama.log").write_text(diagnostics.stdout.read())

                def terminate_sandbox():
                    sandbox.terminate(wait=True)
                    report["sandboxExit"] = sandbox.poll()
                    print("Modal terminated:", report["sandboxExit"], flush=True)

                cleanup("Ollama logs", collect_logs)
                cleanup("Modal termination", terminate_sandbox)
                cleanup("Modal detach", sandbox.detach)
            if daemon is not None:
                cleanup(
                    "Tailscale logout",
                    lambda: subprocess.run(
                        [*ts, "logout"], timeout=10, capture_output=True, check=True
                    ),
                )
                cleanup("Tailscale daemon termination", daemon.terminate)
                try:
                    daemon.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    daemon.kill()
            log.close()

            def remove_peers():
                for device in api("GET", "tailnet/-/devices")["devices"]:
                    if device.get("hostname", "").startswith(prefix):
                        api("DELETE", "device/" + device["id"])
                remaining = api("GET", "tailnet/-/devices")["devices"]
                assert not any(
                    d.get("hostname", "").startswith(prefix) for d in remaining
                )

            cleanup("temporary peers", remove_peers)
            for key in keys:

                def remove_key(key_id=key["id"]):
                    try:
                        api("DELETE", "tailnet/-/keys/" + key_id)
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise

                cleanup("enrollment key", remove_key)
            report.update(finished=time.time(), cleanupErrors=cleanup_errors)
            (artifacts / "infrastructure.json").write_text(json.dumps(report, indent=2))
            if cleanup_errors:
                raise RuntimeError("Incomplete cleanup: " + ", ".join(cleanup_errors))
            print("Temporary peers and enrollment keys cleaned up", flush=True)


if __name__ == "__main__":
    main()
