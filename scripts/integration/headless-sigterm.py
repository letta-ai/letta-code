"""Linux one-shot CLI regression. Run after bun run build with python3 <this file>."""

import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            b'{"object":"list","data":[{"id":"policy","object":"model","owned_by":"local"}]}'
        )

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        send_tool = self.server.command and not self.server.ready.is_set()
        if send_tool:
            call = {
                "index": 0,
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "Bash",
                    "arguments": json.dumps(self.server.command),
                },
            }
            for delta, finish in [
                ({"role": "assistant", "tool_calls": [call]}, None),
                ({}, "tool_calls"),
            ]:
                chunk = {
                    "id": "completion",
                    "model": "policy",
                    "created": 1,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.wfile.write(b": connected\n\n")
        self.wfile.flush()
        self.server.ready.set()
        if not send_tool:
            self.server.release.wait(30)


def wait_for(predicate, description):
    deadline = time.monotonic() + 15
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError(f"timed out waiting for {description}")
        time.sleep(0.02)


class Shutdown(unittest.TestCase):
    def exercise(self, cli, scenario):
        with (
            tempfile.TemporaryDirectory() as tmp,
            ThreadingHTTPServer(("127.0.0.1", 0), Provider) as server,
        ):
            root = Path(tmp)
            ready, cleaned = root / "pid", root / "cleaned"
            child = root / "child.py"
            child.write_text(
                "import os, signal, time, sys\n"
                "def clean(*_):\n"
                "    time.sleep(.7)\n"
                f"    open({str(cleaned)!r}, 'w').close()\n"
                "    sys.exit(0)\n"
                f"signal.signal(signal.SIGTERM, {'clean' if scenario == 'grace' else 'signal.SIG_IGN'})\n"
                f"open({str(ready)!r}, 'w').write(str(os.getpid()))\n"
                "signal.pause()\n"
            )
            server.command = (
                None
                if scenario == "silent"
                else {
                    "command": f"{shlex.quote(sys.executable)} {shlex.quote(str(child))} >/dev/null 2>&1 & wait",
                    "description": "Wait for child",
                    "timeout": 60000,
                }
            )
            if scenario == "background":
                server.command["run_in_background"] = True
            server.ready, server.release = threading.Event(), threading.Event()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            env = {
                "PATH": os.environ["PATH"],
                "HOME": tmp,
                "LETTA_HOME": tmp,
                "DO_NOT_TRACK": "1",
                "LLAMA_CPP_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
            }
            spec = root / "agent.json"
            spec.write_text(
                json.dumps(
                    {
                        "name": "shutdown-test",
                        "model": "llama-cpp/policy",
                        "system": "Run the command.",
                        "max_tokens": 512,
                        "context_window_limit": 32000,
                    }
                )
            )
            agent = json.loads(
                subprocess.check_output(
                    [
                        *cli,
                        "agents",
                        "create",
                        "--backend",
                        "local",
                        "--body",
                        str(spec),
                    ],
                    env=env,
                    timeout=30,
                )
            )
            read_fd, write_fd = os.pipe()
            try:
                with (
                    (root / "cli.log").open("w") as log,
                    subprocess.Popen(
                        [
                            *cli,
                            "--backend",
                            "local",
                            "--agent",
                            agent["id"],
                            "--output-format",
                            "stream-json",
                            "--yolo",
                            "-p",
                            "Run.",
                        ],
                        env=env,
                        stdout=write_fd,
                        stderr=log,
                    ) as proc,
                ):
                    try:
                        self.assertTrue(
                            server.ready.wait(20), "provider request never arrived"
                        )
                        if server.command:
                            wait_for(
                                lambda: ready.exists() and ready.stat().st_size,
                                "foreground child",
                            )
                        if scenario == "full":
                            os.set_blocking(write_fd, False)
                            for size in (4096, 1):
                                try:
                                    while True:
                                        os.write(write_fd, b"x" * size)
                                except BlockingIOError:
                                    pass
                        interrupt = (
                            signal.SIGINT if scenario == "sigint" else signal.SIGTERM
                        )
                        proc.send_signal(interrupt)
                        self.assertEqual(proc.wait(timeout=7), 128 + interrupt)
                        if scenario == "grace":
                            self.assertTrue(
                                cleaned.exists(), "TERM cleanup was cut short"
                            )
                        if ready.exists():
                            stat = Path(f"/proc/{ready.read_text()}/stat")
                            try:
                                alive = stat.read_text().split()[2] != "Z"
                            except FileNotFoundError:
                                alive = False
                            self.assertEqual(
                                alive,
                                scenario == "background",
                                "unexpected descendant state after CLI exit",
                            )
                        if scenario != "full":
                            os.close(write_fd)
                            write_fd = -1
                            frames = [
                                json.loads(line)
                                for line in os.read(read_fd, 65536).splitlines()
                            ]
                            self.assertEqual(
                                [
                                    f.get("message")
                                    for f in frames
                                    if f.get("stop_reason") == "cancelled"
                                ],
                                [f"Interrupted by {interrupt.name}"],
                            )
                    finally:
                        proc.kill()
                        if ready.exists() and ready.read_text():
                            try:
                                os.kill(int(ready.read_text()), signal.SIGKILL)
                            except ProcessLookupError:
                                pass
            finally:
                os.close(read_fd)
                if write_fd >= 0:
                    os.close(write_fd)
                server.release.set()
                server.shutdown()

    def test_shutdown(self):
        for cli in (
            ["node", "letta.js"],
            [
                "bun",
                "--loader=.md:text",
                "--loader=.mdx:text",
                "--loader=.txt:text",
                "run",
                "src/index.ts",
            ],
        ):
            for scenario in ("silent", "full", "grace", "sigint", "background"):
                with self.subTest(runtime=cli[0], scenario=scenario):
                    self.exercise(cli, scenario)


if __name__ == "__main__":
    unittest.main()
