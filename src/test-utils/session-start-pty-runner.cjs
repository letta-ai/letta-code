const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");

const [
  ,
  ,
  cliPath,
  projectRoot,
  runtime,
  fixture,
  agentId,
  currentId,
  targetId,
] = process.argv;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const stripAnsi = (await import("strip-ansi")).default;
  const homeDir = path.join(fixture, "home");
  const projectDir = path.join(fixture, "project");
  const auditPath = path.join(fixture, "events.jsonl");
  const recorder = path.join(fixture, "record.cjs");
  fs.mkdirSync(path.join(homeDir, ".letta"), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    recorder,
    'const fs = require("node:fs"); let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { fs.appendFileSync(process.argv[2], JSON.stringify(JSON.parse(input)) + "\\n"); });',
  );
  fs.writeFileSync(
    path.join(homeDir, ".letta", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} ${JSON.stringify(auditPath)}`,
                quiet: true,
                timeout: 5000,
              },
            ],
          },
        ],
      },
    }),
  );
  function events() {
    if (!fs.existsSync(auditPath)) return [];
    return fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
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
          `Timed out waiting for ${label}; events=${JSON.stringify(events())}\n${stripAnsi(output).slice(-2000)}`,
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

  async function expectEvent(count, conversationId, isNew) {
    await waitFor(
      () => events().length >= count,
      `SessionStart ${count} for ${conversationId}`,
    );
    await sleep(100);
    assert.equal(events().length, count);
    const event = events()[count - 1];
    assert.equal(event.event_type, "SessionStart");
    assert.equal(event.agent_id, agentId);
    assert.equal(event.conversation_id, conversationId);
    assert.equal(event.is_new_session, isNew);
  }

  try {
    await expectEvent(1, currentId, false);
    await waitFor(() => output.includes("\x1b[?2004h"), "interactive input");
    await waitFor(
      () => stripAnsi(output).includes("Resuming new conversation"),
      "startup completion",
    );
    await sleep(200);
    await command(`/resume ${targetId}`, "Resumed conversation");
    await expectEvent(2, targetId, false);
    await command(`/resume ${targetId}`, "Already on this conversation");
    assert.equal(events().length, 2);
    await command("/resume help", "Resume a previous conversation");
    assert.equal(events().length, 2);
    await command(`/resume ${currentId}`, "Switched to conversation");
    await expectEvent(3, currentId, false);
    await command("/resume default", "Switched to conversation");
    await expectEvent(4, "default", false);
    await command("/new Created by audit", "Started new conversation");
    await waitFor(() => events().length >= 5, "new conversation event");
    const newId = events()[4].conversation_id;
    await expectEvent(5, newId, true);
    await command("/fork", "Forked conversation");
    await waitFor(() => events().length >= 6, "fork event");
    await expectEvent(6, events()[5].conversation_id, true);
    await command("/clear", "Agent's in-context messages cleared");
    await waitFor(() => events().length >= 7, "clear event");
    await expectEvent(7, events()[6].conversation_id, true);

    const offset = output.length;
    terminal.write("/resume");
    await sleep(150);
    terminal.write("\r");
    await waitFor(
      () => stripAnsi(output.slice(offset)).includes("Enter select"),
      "conversation selector",
    );
    terminal.write("Resume target");
    await sleep(600);
    terminal.write("\r");
    await expectEvent(8, targetId, false);
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, ".letta", "settings.local.json"),
        "utf8",
      ),
    );
    assert.equal(saved.lastSession.conversationId, targetId);
    await command("/exit", "See ya!");
    await waitFor(() => exitEvent !== undefined, "clean exit");
    assert.equal(exitEvent.exitCode, 0);
    console.log("SessionStart transitions verified");
  } finally {
    if (!exitEvent) terminal.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
