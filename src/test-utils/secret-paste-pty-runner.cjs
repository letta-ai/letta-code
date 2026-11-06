const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");

const [, , cliPath, projectRoot, runtime, fixture, agentId, currentId] =
  process.argv;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const stripAnsi = (await import("strip-ansi")).default;
  const homeDir = path.join(fixture, "home");
  const projectDir = path.join(fixture, "project");
  const secretsPath = path.join(
    fixture,
    "backend",
    "secrets",
    "local-agent-secrets.json",
  );
  fs.mkdirSync(path.join(homeDir, ".letta"), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".letta", "settings.json"),
    JSON.stringify({ preferredBackendMode: "local" }),
  );
  function storedValue() {
    return JSON.parse(fs.readFileSync(secretsPath, "utf8")).secrets[
      `agent:${agentId}:secrets:PASTE_TEST_TOKEN`
    ];
  }

  let output = "";
  let exitEvent;
  const terminal = pty.spawn(
    runtime,
    [
      ...(runtime === "bun"
        ? [
            `--config=${path.join(projectRoot, "bunfig.toml")}`,
            path.join(projectRoot, "src/index.ts"),
          ]
        : [cliPath]),
      "--backend",
      "local",
      "--conversation",
      currentId,
      "--memfs-startup",
      "skip",
      "--no-mods",
    ],
    {
      cols: 100,
      rows: 30,
      cwd: projectDir,
      name: "xterm-256color",
      env: {
        PATH: process.env.PATH,
        HOME: homeDir,
        TERM: "xterm-256color",
        LETTA_LOCAL_BACKEND_DIR: path.join(fixture, "backend"),
        LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
        LETTA_CODE_TELEM: "0",
        DO_NOT_TRACK: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    },
  );
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit((event) => {
    exitEvent = event;
  });

  async function waitFor(predicate, label) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (exitEvent || Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${label}\n${stripAnsi(output).slice(-2000)}`,
        );
      }
      await sleep(25);
    }
  }

  async function command(text, expected) {
    const offset = output.length;
    terminal.write(text);
    await sleep(150);
    terminal.write("\r");
    await waitFor(
      () => stripAnsi(output.slice(offset)).includes(expected),
      text,
    );
    await sleep(100);
  }

  try {
    await waitFor(() => output.includes("\x1b[?2004h"), "interactive input");
    await waitFor(
      () => stripAnsi(output).includes("Resuming new conversation"),
      "startup completion",
    );
    await sleep(200);
    const typed = "FlyV1 synthetic-macaroon-one synthetic-macaroon-two";
    await command(
      `/secret set PASTE_TEST_TOKEN ${typed}`,
      "Secret '$PASTE_TEST_TOKEN' set.",
    );
    assert.equal(storedValue(), typed);

    for (const value of [
      "synthetic first line\nsynthetic second line",
      ` \tFlyV1 ${"synthetic-macaroon ".repeat(40)}\nsecond line \t\n`,
    ]) {
      const offset = output.length;
      terminal.write("/secret set PASTE_TEST_TOKEN ");
      await sleep(150);
      terminal.write(`\x1b[200~${value}\x1b[201~`);
      const collapsed = value.length > 500;
      await waitFor(
        () =>
          stripAnsi(output.slice(offset)).includes(
            collapsed ? "[Pasted text #" : "synthetic second line",
          ),
        "pasted value in composer",
      );
      await sleep(100);
      terminal.write("\r");
      await waitFor(
        () =>
          stripAnsi(output.slice(offset)).includes(
            "Secret '$PASTE_TEST_TOKEN' set.",
          ),
        "saved pasted value",
      );
      assert.equal(storedValue(), value);
      await sleep(100);
    }

    const beforeExpired = storedValue();
    await command(
      "/secret set PASTE_TEST_TOKEN [Pasted text #999999 +1 lines]",
      "Paste the value again",
    );
    assert.equal(storedValue(), beforeExpired);
    await command("/exit", "See ya!");
    await waitFor(() => exitEvent !== undefined, "clean exit");
    assert.equal(exitEvent.exitCode, 0);
    console.log("Secret paste values verified");
  } finally {
    if (!exitEvent) terminal.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
