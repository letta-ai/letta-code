"""Install and exercise a wheel offline, outside the checkout and without Node/npm on PATH."""

import json
import os
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

PROBE = r"""
import {createRequire as bootstrapRequire} from 'node:module';
const require = bootstrapRequire(import.meta.url);
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const cli = process.argv[1];
const app = path.dirname(cli);
const req = createRequire(cli);
const env = {...process.env};
delete env.NODE_OPTIONS;
assert.equal(process.env.LETTA_CODE_DISTRIBUTION, 'pypi');
assert.deepEqual(process.argv.slice(2), ['space argument', 'unicode-λ', '--literal=$HOME']);
assert.ok(process.execPath.includes('_payload'));
const child = spawnSync('node', ['-p', 'process.execPath'], {env, encoding:'utf8'});
assert.equal(child.status, 0, child.stderr);
assert.equal(fs.realpathSync(child.stdout.trim()), fs.realpathSync(process.execPath));
if (process.platform !== 'win32') {
  const direct = spawnSync(cli, ['--version'], {env, encoding:'utf8'});
  assert.equal(direct.status, 0, direct.stderr); // Executable bits + /usr/bin/env node.
  assert.match(direct.stdout, /Letta Code/);
}
assert.ok(fs.existsSync(path.join(app, 'skills', 'letta-guide', 'SKILL.md')));
assert.ok(fs.existsSync(path.join(app, 'assets', 'tutor-profile.png')));
const rg = spawnSync(req('@vscode/ripgrep').rgPath, ['--version'], {env, encoding:'utf8'});
assert.equal(rg.status, 0, rg.stderr);
assert.match(rg.stdout, /ripgrep/);
assert.equal(typeof req('ws').WebSocketServer, 'function');
(async () => {
  const {Bot} = req('grammy');
  const bot = new Bot('123:test');
  bot.api.config.use(async () => ({ok:true, result:{id:123, is_bot:true, first_name:'wheel', username:'wheel_bot'}}));
  await bot.init();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2"><rect width="3000" height="2" fill="red"/></svg>';
  const resized = spawnSync(process.execPath, [path.join(app, 'image-resize-worker.js'), 'image/svg+xml'], {input:svg, env});
  assert.equal(resized.status, 0, resized.stderr.toString());
  const image = JSON.parse(resized.stdout);
  assert.ok(image.width > 0 && image.width < 3000, JSON.stringify(image));
  const pty = req('node-pty').spawn(process.execPath, [cli, '--help'], {env, cols:100, rows:30});
  let output = '';
  pty.onData(data => { output += data; });
  const timeout = setTimeout(() => { pty.kill(); throw new Error('PTY timed out'); }, 30000);
  pty.onExit(({exitCode}) => {
    clearTimeout(timeout);
    assert.equal(exitCode, 0, output);
    assert.match(output, /USAGE/);
    console.log('native PTY, image worker, ripgrep, Telegram, assets and child Node passed');
    process.exit(23); // Verify the Python launcher preserves child exit status.
  });
})().catch(error => {console.error(error); process.exit(1)});
// Hold ESM startup until the asynchronous probe exits; never execute CLI args.
await new Promise(() => {});
"""


def main():
    wheel = Path(sys.argv[1]).resolve()
    if wheel.stat().st_size >= 100 * 1024 * 1024:
        raise SystemExit("Wheel exceeds the default PyPI 100 MiB artifact limit")
    with tempfile.TemporaryDirectory(prefix="letta wheel smoke ") as temporary:
        root = Path(temporary)
        environment = root / "venv"
        venv.create(environment, with_pip=True)
        binary = environment / ("Scripts" if os.name == "nt" else "bin")
        python = binary / ("python.exe" if os.name == "nt" else "python")
        cli = binary / ("letta.exe" if os.name == "nt" else "letta")
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                str(wheel),
            ],
            check=True,
        )
        home = root / "home"
        home.mkdir()
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("LETTA", "NODE_", "NPM_"))
            and k not in ("AGENT_ID", "CONVERSATION_ID", "MEMORY_DIR")
        }
        env.update(
            HOME=str(home),
            USERPROFILE=str(home),
            PATH=str(binary),
            DISABLE_AUTOUPDATER="0",
        )
        if os.name == "nt":
            env["PATH"] += os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32")
        for args, expected, code in [
            (["--help"], "USAGE", 0),
            (["--version"], "Letta Code", 0),
            (["update"], "uv tool upgrade letta", 1),
        ]:
            result = subprocess.run(
                [str(cli), *args],
                cwd=root,
                env=env,
                check=False,
                capture_output=True,
                text=True,
                timeout=45,
            )
            assert result.returncode == code, (args, result.stdout, result.stderr)
            assert expected in result.stdout + result.stderr, result
        env.update(
            LETTA_LOCAL_BACKEND_DIR=str(root / "local-store"),
            LETTA_LOCAL_BACKEND_EXECUTOR="deterministic",
            LETTA_SKIP_KEYCHAIN_CHECK="1",
        )
        result = subprocess.run(
            [
                str(cli),
                "--backend",
                "local",
                "--ephemeral",
                "-m",
                "openai/gpt-5.6-luna",
                "-p",
                "wheel runtime smoke",
                "--tools=",
                "--output-format",
                "json",
            ],
            cwd=root,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, (result.stdout, result.stderr)
        response = json.loads(result.stdout)
        assert response["conversation_id"].startswith("local-conv-"), response
        assert response["result"], response
        print("Installed headless deterministic local turn passed")
        probe = root / "probe.mjs"
        probe.write_text(PROBE, encoding="utf-8")
        env["NODE_OPTIONS"] = "--import=" + json.dumps(probe.as_uri())
        result = subprocess.run(
            [str(cli), "space argument", "unicode-λ", "--literal=$HOME"],
            cwd=root,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        print(result.stdout, result.stderr)
        assert result.returncode == 23, result
        if os.name != "nt":
            import selectors
            import signal

            signal_probe = root / "signal.mjs"
            signal_probe.write_text(
                "process.on('SIGTERM', () => process.exit(42)); console.log(process.pid); setInterval(() => {}, 1000); await new Promise(() => {});"
            )
            env["NODE_OPTIONS"] = "--import=" + json.dumps(signal_probe.as_uri())
            process = subprocess.Popen(
                [str(cli)],
                cwd=root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    assert selector.select(timeout=15), "Signal probe did not start"
                    assert int(process.stdout.readline()) == process.pid, (
                        "Launcher did not exec Node"
                    )
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=15)
                assert process.returncode == 42, process.returncode
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            print("POSIX PID and SIGTERM forwarding passed")
        print(f"Installed wheel smoke passed: {wheel.name}")


if __name__ == "__main__":
    main()
