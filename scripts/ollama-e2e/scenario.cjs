const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const pty = require("node-pty");
const { createFaultProxy } = require("./fault-proxy.cjs");

const exec = promisify(execFile);
const cli = path.resolve(__dirname, "../../letta.js");
const model = "ollama/qwen3.5:9b";
const artifacts = path.resolve(
  process.env.OLLAMA_E2E_ARTIFACTS || ".cache/ollama-e2e",
);
const activeProcesses = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const messageKey = (message) =>
  `${message.metadata?.conversation_id}:${message.id}`;

async function waitFor(predicate, label, alive, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (alive && !alive())
      throw new Error(`CLI exited while waiting for ${label}`);
    const result = await predicate();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fixture(cwd, name) {
  const values = [
    Math.floor(Math.random() * 90) + 10,
    Math.floor(Math.random() * 90) + 10,
  ];
  fs.writeFileSync(path.join(cwd, `${name}.json`), JSON.stringify({ values }));
  return {
    prompt: `Read ${name}.json in the current directory using a tool. Add the two values and use a tool to write only their decimal sum to ${name}.txt. Do not ask questions. After the file is written, reply with DONE.`,
    verify() {
      assertSum(
        fs.readFileSync(path.join(cwd, `${name}.txt`), "utf8").trim(),
        values[0] + values[1],
      );
    },
  };
}

function assertSum(text, expected) {
  assert.match(
    text,
    /^\d+(?:\.0+)?$/,
    "Output must contain only the numeric sum",
  );
  assert.equal(Number(text), expected);
}

function minimalEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    DISABLE_AUTOUPDATER: "1",
    LETTA_DISABLE_SESSION_PERSIST: "1",
    LETTA_LOCAL_BACKEND_DIR: path.join(home, "store"),
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
  };
}

async function command(env, cwd, ...args) {
  const result = await exec(
    process.execPath,
    [cli, "--backend", "local", ...args],
    {
      env,
      cwd,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.stdout;
}

function headless(env, cwd, agent, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "--backend",
      "local",
      ...(agent ? ["--agent", agent] : ["--new-agent"]),
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--yolo",
      "--reflection-trigger",
      "off",
      ...extraArgs,
    ],
    { env, cwd },
  );
  const events = [];
  activeProcesses.add(child);
  let buffer = "";
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.on("error", (error) => {
    stderr += error.stack;
    exited = true;
  });
  child.on("exit", () => {
    exited = true;
    activeProcesses.delete(child);
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdout.on("data", (data) => {
    stdout += data;
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* Diagnostics remain in stdout. */
      }
    }
  });
  return {
    pid: child.pid,
    alive: () => !exited,
    async init() {
      return waitFor(
        () => events.find((e) => e.type === "system" && e.subtype === "init"),
        "headless init",
        () => !exited,
      );
    },
    async turn(prompt, expected, identity) {
      const start = events.length;
      child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: prompt },
        }) + "\n",
      );
      const result = await waitFor(
        () => events.slice(start).find((e) => e.type === "result"),
        "headless terminal result",
        () => !exited,
      );
      assert.equal(result.subtype, expected, JSON.stringify(result));
      assert.equal(result.agent_id, identity.agent_id);
      assert.equal(result.conversation_id, identity.conversation_id);
      assert.equal(result.session_id, identity.session_id);
      assert.ok(!exited, "Recovery must not replace the process");
      return events.slice(start);
    },
    async close(label) {
      fs.writeFileSync(path.join(artifacts, `${label}.stdout.jsonl`), stdout);
      fs.writeFileSync(path.join(artifacts, `${label}.stderr.log`), stderr);
      child.stdin.end();
      try {
        await waitFor(() => exited, "headless shutdown", null, 5000);
      } catch {
        child.kill("SIGTERM");
        await sleep(500);
        if (!exited) child.kill("SIGKILL");
      }
    },
  };
}

function assertTools(events) {
  const calls = events.filter((e) => e.message_type === "tool_call_message");
  assert.ok(calls.length > 0, "No tool calls observed");
  const returns = events.filter(
    (e) => e.message_type === "tool_return_message" && e.status === "success",
  );
  assert.ok(
    calls.some((call) =>
      returns.some((ret) => ret.tool_call_id === call.tool_call?.tool_call_id),
    ),
    "No successful paired tool return",
  );
}

async function runHeadless(env, cwd, agent, proxy, summary) {
  const session = headless(env, cwd, agent);
  try {
    const identity = await session.init();
    assert.equal(identity.model, "qwen3.5:9b");
    assert.ok(identity.tools.length > 5, "Normal tools must remain enabled");
    summary.headless = { pid: session.pid, ...identity };
    const healthy = async (name) => {
      const task = fixture(cwd, name);
      const events = await session.turn(task.prompt, "success", identity);
      assertTools(events);
      task.verify();
      console.log(`PASS headless ${name}`);
    };
    await healthy("cold-default-timeout");
    proxy.setFault("delay", 1500);
    await healthy("delayed-headers");
    proxy.setFault("none");
    // Reconfigure through the product command. Each turn reads the provider record.
    await command(
      env,
      cwd,
      "connect",
      "ollama",
      "--base-url",
      proxy.url + "/v1",
      "--timeout",
      "2s",
    );
    proxy.setFault("timeout");
    const before = proxy.requests.length;
    await session.turn(
      "Reply with the word hello. Do not use tools.",
      "error",
      identity,
    );
    const timedOut = proxy.requests
      .slice(before)
      .filter((r) => r.mode === "timeout");
    assert.ok(
      timedOut.length > 0,
      "No inference request reached the timeout fault",
    );
    assert.ok(
      timedOut.every(
        (r) => r.closed - r.started >= 1500 && r.closed - r.started < 5000,
      ),
      "Failure was not the configured timeout",
    );
    proxy.setFault("none");
    await command(
      env,
      cwd,
      "connect",
      "ollama",
      "--base-url",
      proxy.url + "/v1",
      "--timeout",
      "300s",
    );
    await healthy("after-timeout");
    proxy.setFault("drop");
    await session.turn(
      "Count from one to twenty in words. Do not use tools.",
      "error",
      identity,
    );
    assert.ok(
      proxy.requests.some((r) => r.droppedAfterOutput),
      "No actual model output preceded the drop",
    );
    proxy.setFault("none");
    await healthy("after-drop");
  } finally {
    await session.close("headless");
  }
  const next = headless(env, cwd, agent, ["--new"]);
  try {
    const identity = await next.init();
    assert.equal(identity.model, "qwen3.5:9b");
    assert.notEqual(identity.conversation_id, summary.headless.conversation_id);
    const task = fixture(cwd, "new-conversation");
    assertTools(await next.turn(task.prompt, "success", identity));
    task.verify();
    console.log("PASS new conversation preserves Ollama");
  } finally {
    await next.close("new-conversation");
  }
}

function readMessages(store) {
  const root = path.join(store, "conversations");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((dir) => {
    const file = path.join(root, dir, "messages.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.type === "message" && entry.message
            ? [entry.message]
            : [];
        } catch {
          return [];
        }
      });
  });
}

async function runTui(env, cwd, agent, proxy, summary) {
  const stripAnsi = (await import("strip-ansi")).default;
  let output = "";
  let exited = false;
  const terminal = pty.spawn(
    process.execPath,
    [
      cli,
      "--backend",
      "local",
      "--agent",
      agent,
      "--new",
      "--yolo",
      "--reflection-trigger",
      "off",
    ],
    {
      env,
      cwd,
      cols: 120,
      rows: 35,
      name: "xterm-256color",
    },
  );
  const liveLog = fs.createWriteStream(path.join(artifacts, "tui.raw.log"));
  const outputSubscription = terminal.onData((data) => {
    output += data;
    liveLog.write(data);
  });
  activeProcesses.add(terminal);
  terminal.onExit(() => {
    exited = true;
    activeProcesses.delete(terminal);
  });
  const alive = () => !exited;
  // Ctrl-U clears a prompt the TUI restores after an error. It does not cancel a run.
  const submit = async (text) => {
    terminal.write("\x15");
    await sleep(50);
    terminal.write("\x1b[200~" + text + "\x1b[201~");
    await sleep(100);
    terminal.write("\r");
  };
  const messages = () => readMessages(env.LETTA_LOCAL_BACKEND_DIR);
  const healthy = async (name) => {
    const ids = new Set(messages().map(messageKey));
    const task = fixture(cwd, name);
    await submit(task.prompt);
    const final = await waitFor(
      () =>
        messages().find(
          (m) =>
            !ids.has(messageKey(m)) &&
            m.role === "assistant" &&
            m.stopReason === "stop",
        ),
      name,
      alive,
    );
    task.verify();
    const added = messages().filter((m) => !ids.has(messageKey(m)));
    const calls = added.flatMap((m) =>
      m.role === "assistant"
        ? m.content.filter((part) => part.type === "toolCall")
        : [],
    );
    assert.ok(
      added.some(
        (m) =>
          m.role === "toolResult" &&
          !m.isError &&
          calls.some((call) => call.id === m.toolCallId),
      ),
      "TUI had no successful paired tool result",
    );
    assert.equal(final.provider, "ollama");
    assert.equal(final.model, "qwen3.5:9b");
    console.log(`PASS TUI ${name}`);
    await sleep(250); // Allow the completed turn's UI cleanup before keyboard input.
    return final.metadata?.conversation_id;
  };
  try {
    await waitFor(
      () =>
        output.includes("\x1b[?2004h") && stripAnsi(output).includes("qwen"),
      "TUI input ready",
      alive,
    );
    const conversation = await healthy("tui-healthy");
    assert.ok(conversation, "Missing persisted TUI conversation identity");
    summary.tui = { pid: terminal.pid, agent, conversation };
    for (const fault of ["timeout", "drop"]) {
      if (fault === "timeout")
        await command(
          env,
          cwd,
          "connect",
          "ollama",
          "--base-url",
          proxy.url + "/v1",
          "--timeout",
          "2s",
        );
      const offset = output.length;
      const start = proxy.requests.length;
      proxy.setFault(fault);
      await submit("Count from one to twenty in words. Do not use tools.");
      await waitFor(
        () => {
          const text = stripAnsi(output.slice(offset));
          return (
            /Something went wrong\? Use \/feedback to report issues\.|An error occurred during agent execution|Downstream provider is experiencing errors/.test(
              text,
            ) && proxy.requests.slice(start).some((r) => r.mode === fault)
          );
        },
        `TUI terminal ${fault} error`,
        alive,
      );
      if (fault === "drop")
        assert.ok(
          proxy.requests.slice(start).some((r) => r.droppedAfterOutput),
        );
      else
        assert.ok(
          proxy.requests
            .slice(start)
            .filter((r) => r.mode === "timeout")
            .every(
              (r) =>
                r.closed - r.started >= 1500 && r.closed - r.started < 5000,
            ),
          "TUI did not reach the configured timeout",
        );
      proxy.setFault("none");
      await command(
        env,
        cwd,
        "connect",
        "ollama",
        "--base-url",
        proxy.url + "/v1",
        "--timeout",
        "300s",
      );
      await sleep(250);
      assert.equal(
        await healthy(`tui-after-${fault}`),
        conversation,
        "TUI recovery changed conversation",
      );
    }
    const offset = output.length;
    await submit("/new");
    await waitFor(
      () =>
        stripAnsi(output.slice(offset)).includes("Started new conversation"),
      "TUI /new",
      alive,
    );
    await sleep(250);
    assert.notEqual(await healthy("tui-new-conversation"), conversation);
  } finally {
    fs.writeFileSync(path.join(artifacts, "tui.log"), stripAnsi(output));
    outputSubscription.dispose();
    liveLog.end();
    terminal.kill();
    await sleep(500);
    if (!exited) terminal.kill("SIGKILL");
  }
}

async function main() {
  assert.ok(
    process.env.OLLAMA_BASE_URL,
    "OLLAMA_BASE_URL is required; this test must not silently skip",
  );
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-ollama-e2e-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const env = minimalEnv(home);
  const proxy = await createFaultProxy(
    process.env.OLLAMA_BASE_URL,
    process.env.OLLAMA_E2E_HTTP_PROXY,
  );
  const tuiOnly = process.argv.includes("--tui-only");
  const summary = {
    model,
    scope: tuiOnly ? "tui-only" : "full",
    started: new Date().toISOString(),
  };
  const terminate = (code) => {
    for (const child of activeProcesses) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of activeProcesses) child.kill("SIGKILL");
      process.exit(code);
    }, 1000);
  };
  process.once("SIGTERM", () => terminate(130));
  process.once("SIGINT", () => terminate(130));
  const hardDeadline = setTimeout(() => {
    console.error("E2E exceeded 20-minute deadline");
    terminate(1);
  }, 1200000);
  try {
    console.log(
      await command(
        env,
        cwd,
        "connect",
        "ollama",
        "--base-url",
        proxy.url + "/v1",
      ),
    );
    const agent = JSON.parse(
      await command(
        env,
        cwd,
        "agents",
        "create",
        "--name",
        "Ollama E2E",
        "--personality",
        "letta-code",
        "--model",
        model,
      ),
    );
    const config = JSON.parse(
      await command(env, cwd, "agents", "config", "--agent", agent.id),
    );
    assert.equal(config.effective.model, model);
    if (!tuiOnly) await runHeadless(env, cwd, agent.id, proxy, summary);
    await runTui(env, cwd, agent.id, proxy, summary);
    if (!tuiOnly) {
      const fresh = headless(env, cwd, null);
      try {
        const identity = await fresh.init();
        assert.equal(
          identity.model,
          "qwen3.5:9b",
          "A fresh local agent must use the only configured provider",
        );
        const task = fixture(cwd, "fresh-agent-default");
        assertTools(await fresh.turn(task.prompt, "success", identity));
        task.verify();
        summary.freshAgent = {
          agent: identity.agent_id,
          conversation: identity.conversation_id,
        };
        console.log(
          "PASS fresh agent selects configured Ollama without a model override",
        );
      } finally {
        await fresh.close("fresh-agent");
      }
    }
    const inference = proxy.requests.filter((r) => r.model);
    assert.ok(inference.length > 0);
    assert.ok(
      inference.every((r) => r.model === "qwen3.5:9b"),
      "Unexpected model sent to Ollama",
    );
    assert.ok(
      inference.some((r) => r.toolCount > 5 && r.systemChars > 1000),
      "Normal agent prompt/tool schemas were not exercised",
    );
    summary.success = true;
    console.log(
      tuiOnly ? "PASS Ollama TUI-only E2E" : "PASS Ollama local-backend E2E",
    );
  } finally {
    clearTimeout(hardDeadline);
    const fixtureFiles = fs
      .readdirSync(cwd)
      .filter((file) => /\.(json|txt)$/.test(file));
    summary.fixtures = Object.fromEntries(
      fixtureFiles.map((file) => [
        file,
        fs.readFileSync(path.join(cwd, file), "utf8"),
      ]),
    );
    fs.writeFileSync(
      path.join(artifacts, "transcript.json"),
      JSON.stringify(readMessages(env.LETTA_LOCAL_BACKEND_DIR), null, 2),
    );
    fs.writeFileSync(
      path.join(artifacts, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    fs.writeFileSync(
      path.join(artifacts, "proxy.json"),
      JSON.stringify(proxy.requests, null, 2),
    );
    await proxy.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = {
  minimalEnv,
  assertTools,
  readMessages,
  messageKey,
  assertSum,
};
