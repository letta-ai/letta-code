const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");

const [, , cliPath, projectRoot] = process.argv;
const INK_BRACKETED_PASTE_ENABLE = "\x1b[?2004h";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOutput(getOutput, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = getOutput();
    if (predicate(output)) return output;
    await sleep(25);
  }
  throw new Error(
    `Timed out waiting for ${label}. Output:\n${globalThis.stripAnsi(getOutput()).slice(-4000)}`,
  );
}

function writeBrokenLocalTranscriptStore(homeDir) {
  const lettaDir = path.join(homeDir, ".letta");
  const conversationDir = path.join(
    lettaDir,
    "lc-local-backend",
    "conversations",
    "broken",
  );
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(
    path.join(lettaDir, "settings.json"),
    `${JSON.stringify({ preferredBackendMode: "local" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(conversationDir, "conversation.json"),
    `${JSON.stringify({
      id: "local-conv-broken",
      agent_id: "agent-local-broken",
      in_context_message_ids: [],
    })}\n`,
  );
  fs.writeFileSync(
    path.join(conversationDir, "manifest.json"),
    `${JSON.stringify({
      schema_version: 999,
      message_format: "future-jsonl",
      provider_stack: "pi-ai",
      created_at: new Date().toISOString(),
    })}\n`,
  );
  fs.writeFileSync(path.join(conversationDir, "messages.jsonl"), "");
}

async function main() {
  if (!cliPath || !projectRoot) {
    throw new Error(
      "Usage: startup-setup-pty-runner.cjs <cliPath> <projectRoot>",
    );
  }

  globalThis.stripAnsi = (await import("strip-ansi")).default;

  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "letta-setup-pty-home-"),
  );
  let terminal;
  try {
    writeBrokenLocalTranscriptStore(homeDir);

    let output = "";
    let exited = false;
    terminal = pty.spawn(
      "node",
      // Force API startup so the no-credentials setup menu renders. The test
      // is about PTY raw input after terminal preflight, not explicit cloud
      // agent handling; cloud-agent setup intentionally disables local mode.
      [cliPath, "--backend", "api"],
      {
        cols: 120,
        cwd: projectRoot,
        env: {
          PATH: process.env.PATH,
          HOME: homeDir,
          TERM: "xterm-256color",
          DISABLE_AUTOUPDATER: "1",
          LETTA_DISABLE_SESSION_PERSIST: "1",
        },
        name: "xterm-256color",
        rows: 30,
      },
    );
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(() => {
      exited = true;
    });

    const initialOutput = globalThis.stripAnsi(
      await waitForOutput(
        () => output,
        (current) =>
          globalThis.stripAnsi(current).includes("> Proceed locally (default)"),
        "default local setup selection",
      ),
    );
    if (initialOutput.includes("Unsupported local transcript format")) {
      throw new Error(
        `Local transcript error leaked into setup. Output:\n${initialOutput}`,
      );
    }

    await waitForOutput(
      () => output,
      (current) => current.includes(INK_BRACKETED_PASTE_ENABLE),
      "setup menu raw input mode",
    );

    const beforeInputLength = output.length;
    terminal.write("\x1b[A");
    await waitForOutput(
      () => output,
      (current) =>
        globalThis.stripAnsi(current).includes("> Login to Constellation"),
      "up-arrow selection change",
    );

    const afterInputOutput = globalThis.stripAnsi(
      output.slice(beforeInputLength),
    );
    if (afterInputOutput.includes("^[[A")) {
      throw new Error(
        `Arrow key was echoed instead of handled. Output:\n${afterInputOutput}`,
      );
    }
    if (exited) {
      throw new Error("CLI exited while setup menu should still be active");
    }
  } finally {
    if (terminal) {
      terminal.write("\x03");
      terminal.kill();
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
