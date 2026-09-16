const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");

const [, , cliPath, projectRoot, scenario = "fresh"] = process.argv;
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
    if (scenario === "explicit-cloud") {
      writeBrokenLocalTranscriptStore(homeDir);
    } else if (scenario === "saved-cloud") {
      fs.mkdirSync(path.join(homeDir, ".letta"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".letta", "settings.json"),
        JSON.stringify({ preferredBackendMode: "api" }),
      );
    }

    let output = "";
    let exited = false;
    terminal = pty.spawn(
      "node",
      scenario === "explicit-cloud"
        ? [cliPath, "--backend", "cloud"]
        : [cliPath],
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
          globalThis
            .stripAnsi(current)
            .includes("> Sign in with Letta (default)"),
        "default cloud setup selection",
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
    terminal.write("\x1b[B");
    await waitForOutput(
      () => output,
      (current) =>
        globalThis
          .stripAnsi(current.slice(beforeInputLength))
          .includes(
            scenario === "explicit-cloud" ? "> Exit" : "> Proceed locally",
          ),
      "down-arrow selection change",
    );

    const afterInputOutput = globalThis.stripAnsi(
      output.slice(beforeInputLength),
    );
    if (afterInputOutput.includes("^[[B")) {
      throw new Error(
        `Arrow key was echoed instead of handled. Output:\n${afterInputOutput}`,
      );
    }
    if (exited) {
      throw new Error("CLI exited while setup menu should still be active");
    }
    if (scenario !== "explicit-cloud") {
      const beforeExitSelection = output.length;
      terminal.write("\x1b[B");
      await waitForOutput(
        () => output,
        (current) =>
          globalThis
            .stripAnsi(current.slice(beforeExitSelection))
            .includes("> Exit"),
        "exit selection",
      );
    }
    terminal.write("\r");
    await waitForOutput(
      () => output,
      () => exited,
      "setup cancellation",
    );
    const settings = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".letta", "settings.json"), "utf8"),
    );
    const expectedPreference =
      scenario === "explicit-cloud"
        ? "local"
        : scenario === "saved-cloud"
          ? "api"
          : undefined;
    if (settings.preferredBackendMode !== expectedPreference) {
      throw new Error(
        `Setup cancellation changed the saved backend: ${settings.preferredBackendMode}`,
      );
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
