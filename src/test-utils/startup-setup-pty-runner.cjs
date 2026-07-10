const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");

const [, , cliPath, projectRoot, scenario = "setup-menu-raw-input"] =
  process.argv;
const INK_BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const FALLBACK_AGENT_ID = "agent-existing-1";
const FALLBACK_AGENT_NAME = "Existing Agent";

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

async function waitForExit(getOutput, hasExited, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) return;
    await sleep(25);
  }
  throw new Error(
    `Timed out waiting for ${label}. Output:\n${globalThis.stripAnsi(getOutput()).slice(-4000)}`,
  );
}

async function waitForRequest(requests, request, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (requests.includes(request)) return;
    await sleep(25);
  }
  throw new Error(
    `Timed out waiting for ${label}. Requests:\n${requests.join("\n")}`,
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

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

function normalizeRequestPath(pathname) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

async function readRequestBody(req) {
  for await (const _chunk of req) {
    // Drain request bodies so the client can finish cleanly.
  }
}

async function startAgentLimitServer(options = {}) {
  const {
    createStatus = 402,
    createBody = {
      error:
        "You have reached your limit for agents, please upgrade your plan or delete some agents",
      limit: 3,
    },
    listStatus = 200,
    listBody,
  } = options;
  const requests = [];
  const fallbackAgent = {
    id: FALLBACK_AGENT_ID,
    name: FALLBACK_AGENT_NAME,
    tags: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const requestPath = normalizeRequestPath(url.pathname);
    requests.push(`${req.method} ${requestPath}`);

    if (req.method === "GET" && requestPath === "/v1/models") {
      json(res, 200, [
        {
          handle: "openai/gpt-4o-mini",
          max_context_window: 128000,
          model: "gpt-4o-mini",
          model_endpoint_type: "openai",
          provider_type: "openai",
        },
      ]);
      return;
    }

    if (req.method === "POST" && requestPath === "/v1/agents") {
      await readRequestBody(req);
      json(res, createStatus, createBody);
      return;
    }

    if (req.method === "GET" && requestPath === "/v1/agents") {
      json(res, listStatus, listBody ?? [fallbackAgent]);
      return;
    }

    if (
      req.method === "GET" &&
      requestPath === `/v1/agents/${FALLBACK_AGENT_ID}`
    ) {
      json(res, 200, fallbackAgent);
      return;
    }

    json(res, 404, { error: `Unexpected fake API route ${req.method} ${url}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake API server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
  };
}

async function runSetupMenuRawInput() {
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

async function runAgentLimitFallback() {
  const fakeApi = await startAgentLimitServer();
  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "letta-agent-limit-pty-home-"),
  );
  let terminal;
  try {
    let output = "";
    let exited = false;
    terminal = pty.spawn("node", [cliPath, "--backend", "api"], {
      cols: 120,
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        HOME: homeDir,
        TERM: "xterm-256color",
        DISABLE_AUTOUPDATER: "1",
        LETTA_BASE_URL: fakeApi.baseUrl,
        LETTA_DISABLE_SESSION_PERSIST: "1",
        LETTA_REQUEST_TIMEOUT_MS: "2000",
      },
      name: "xterm-256color",
      rows: 30,
    });
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(() => {
      exited = true;
    });

    await waitForOutput(
      () => output,
      (current) =>
        globalThis
          .stripAnsi(current)
          .includes("Failed to create default agent"),
      "default-agent creation failure",
    );

    await waitForOutput(
      () => output,
      (current) => {
        const stripped = globalThis.stripAnsi(current);
        return (
          stripped.includes("You have reached your limit for agents") &&
          stripped.includes(
            `Selected existing agent "${FALLBACK_AGENT_NAME}" (${FALLBACK_AGENT_ID})`,
          ) &&
          stripped.includes("Press any key to continue")
        );
      },
      "fallback selected-agent acknowledgement",
    );

    if (exited) {
      throw new Error(
        `CLI exited before fallback acknowledgement. Output:\n${globalThis.stripAnsi(output)}`,
      );
    }

    const continuationRequest = `GET /v1/agents/${FALLBACK_AGENT_ID}/messages`;
    await sleep(250);
    if (fakeApi.requests.includes(continuationRequest)) {
      throw new Error(
        `CLI continued past acknowledgement before keypress. Requests:\n${fakeApi.requests.join("\n")}`,
      );
    }

    terminal.write("x");
    await waitForRequest(
      fakeApi.requests,
      continuationRequest,
      "selected fallback agent session loading after acknowledgement",
    );

    if (exited) {
      throw new Error(
        `CLI exited while continuing after fallback acknowledgement. Output:\n${globalThis.stripAnsi(output)}`,
      );
    }
  } finally {
    if (terminal) {
      terminal.write("\x03");
      terminal.kill();
    }
    await fakeApi.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function runDefaultCreateFailureScenario({
  serverOptions,
  expectedOutput,
  expectListAgents,
}) {
  const fakeApi = await startAgentLimitServer(serverOptions);
  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "letta-create-failure-pty-home-"),
  );
  let terminal;
  let exited = false;
  let exitCode = null;
  try {
    let output = "";
    terminal = pty.spawn("node", [cliPath, "--backend", "api"], {
      cols: 120,
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        HOME: homeDir,
        TERM: "xterm-256color",
        DISABLE_AUTOUPDATER: "1",
        LETTA_BASE_URL: fakeApi.baseUrl,
        LETTA_DISABLE_SESSION_PERSIST: "1",
        LETTA_REQUEST_TIMEOUT_MS: "2000",
      },
      name: "xterm-256color",
      rows: 30,
    });
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
    });

    await waitForOutput(
      () => output,
      (current) =>
        globalThis
          .stripAnsi(current)
          .includes("Failed to create default agent"),
      "default-agent creation failure",
    );
    await waitForExit(
      () => output,
      () => exited,
      "startup failure exit",
    );
    if (exitCode !== 1) {
      throw new Error(
        `Expected startup failure to exit 1, got ${exitCode}. Output:\n${globalThis.stripAnsi(output)}`,
      );
    }

    const stripped = globalThis.stripAnsi(output);
    if (!stripped.includes(expectedOutput)) {
      throw new Error(
        `Expected output to include "${expectedOutput}". Output:\n${stripped}`,
      );
    }
    if (stripped.includes("Selected existing agent")) {
      throw new Error(`Unexpected fallback selection. Output:\n${stripped}`);
    }
    if (stripped.includes("Press any key to continue")) {
      throw new Error(`Unexpected keypress prompt. Output:\n${stripped}`);
    }

    const listAgentRequests = fakeApi.requests.filter(
      (request) => request === "GET /v1/agents",
    ).length;
    if (expectListAgents && listAgentRequests === 0) {
      throw new Error(
        `Expected startup to list existing agents. Requests:\n${fakeApi.requests.join("\n")}`,
      );
    }
    if (!expectListAgents && listAgentRequests !== 0) {
      throw new Error(
        `Did not expect startup to list existing agents. Requests:\n${fakeApi.requests.join("\n")}`,
      );
    }
  } finally {
    if (terminal && !exited) {
      terminal.write("\x03");
      terminal.kill();
    }
    await fakeApi.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!cliPath || !projectRoot) {
    throw new Error(
      "Usage: startup-setup-pty-runner.cjs <cliPath> <projectRoot> [scenario]",
    );
  }

  globalThis.stripAnsi = (await import("strip-ansi")).default;

  if (scenario === "setup-menu-raw-input") {
    await runSetupMenuRawInput();
    return;
  }

  if (scenario === "agent-limit-fallback") {
    await runAgentLimitFallback();
    return;
  }

  if (scenario === "non-quota-create-failure") {
    await runDefaultCreateFailureScenario({
      serverOptions: {
        createStatus: 500,
        createBody: {
          error: "Internal server exploded while creating agent",
        },
      },
      expectedOutput: "Internal server exploded while creating agent",
      expectListAgents: false,
    });
    return;
  }

  if (scenario === "agent-limit-empty-list") {
    await runDefaultCreateFailureScenario({
      serverOptions: { listBody: [] },
      expectedOutput:
        "No existing agents were available after default agent creation failed.",
      expectListAgents: true,
    });
    return;
  }

  if (scenario === "agent-limit-list-failure") {
    await runDefaultCreateFailureScenario({
      serverOptions: {
        listStatus: 500,
        listBody: { error: "Unable to list agents" },
      },
      expectedOutput:
        "Failed to list existing agents after default agent creation failed",
      expectListAgents: true,
    });
    return;
  }

  throw new Error(`Unknown PTY startup scenario: ${scenario}`);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
