const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");

const [, , cliPath, projectRoot, runtime] = process.argv;
const agent = {
  id: "agent-startup-secrets-race",
  name: "Startup Secrets Race",
  tags: [],
  blocks: [],
  tools: [],
  llm_config: { model: "test-model", context_window: 32000 },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, getOutput, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(
    `Timed out waiting for ${label}. Output:\n${getOutput().slice(-4000)}`,
  );
}

function sendJson(response, body, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function main() {
  if (!cliPath || !projectRoot || !["bun", "node"].includes(runtime)) {
    throw new Error(
      "Usage: startup-secrets-pty-runner.cjs <cliPath> <projectRoot> <bun|node>",
    );
  }

  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "letta-secrets-startup-home-"),
  );
  let sawSecretsRequest = false;
  const server = http.createServer((request, response) => {
    const requestPath = request.url ?? "";

    if (requestPath === "/v1/health") {
      sendJson(response, { status: "ok" });
      return;
    }
    if (requestPath.startsWith("/v1/models/catalog")) {
      sendJson(response, {
        models: [
          {
            id: "test-model",
            handle: "test/model",
            label: "Test model",
            brand: "test",
            maxContextWindow: 32000,
            isDefault: true,
          },
        ],
      });
      return;
    }
    if (requestPath.startsWith("/v1/models/")) {
      sendJson(response, []);
      return;
    }
    if (requestPath.startsWith("/v1/agents/?")) {
      sendJson(response, [agent]);
      return;
    }
    if (
      requestPath === `/v1/agents/${agent.id}` ||
      requestPath.startsWith(`/v1/agents/${agent.id}?`)
    ) {
      sendJson(response, agent);
      return;
    }
    if (
      request.method === "POST" &&
      requestPath === "/v1/tools/add-base-tools"
    ) {
      sendJson(response, []);
      return;
    }
    if (requestPath === `/v1/agents/${agent.id}/secrets`) {
      sawSecretsRequest = true;
      sendJson(response, { message: "Agent not found" }, 404);
      return;
    }

    // Keep the message-history request pending so the secrets rejection reaches
    // the event loop before startup arrives at its later synchronization point.
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock API server did not expose a TCP port");
  }

  const entryArgs =
    runtime === "bun"
      ? [
          `--config=${path.join(projectRoot, "bunfig.toml")}`,
          path.join(projectRoot, "src/index.ts"),
        ]
      : [cliPath];
  let terminal;
  let output = "";
  let exitEvent = null;
  try {
    terminal = pty.spawn(
      runtime,
      [
        ...entryArgs,
        "--backend",
        "api",
        "--agent",
        agent.id,
        "--memfs-startup",
        "skip",
      ],
      {
        cols: 120,
        rows: 30,
        cwd: projectRoot,
        name: "xterm-256color",
        env: {
          PATH: process.env.PATH,
          HOME: homeDir,
          TERM: "xterm-256color",
          LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
          LETTA_API_KEY: "test-only-no-network",
          LETTA_SKIP_KEYCHAIN_CHECK: "1",
          LETTA_DISABLE_MODS: "1",
          LETTA_DISABLE_SESSION_PERSIST: "1",
          LETTA_CODE_TELEM: "0",
          LETTA_DEBUG: "1",
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

    await waitFor(
      () => sawSecretsRequest,
      "rejected secrets request",
      () => output,
    );
    await sleep(500);

    if (exitEvent) {
      throw new Error(
        `CLI exited after a nonfatal secrets rejection: ${JSON.stringify(exitEvent)}\n${output.slice(-4000)}`,
      );
    }
    if (!output.includes("Checking for pending approvals...")) {
      throw new Error(
        `CLI did not reach the delayed startup gate. Output:\n${output.slice(-4000)}`,
      );
    }
  } finally {
    if (terminal) {
      terminal.kill();
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
