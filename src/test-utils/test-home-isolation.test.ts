import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { getChannelRoutingPath } from "@/channels/config";
import { addRoute } from "@/channels/routing";

test("unit tests write home-relative state under a disposable home", () => {
  const testHome = process.env.LETTA_TEST_HOME;
  if (!testHome) throw new Error("Test home preload did not run");
  expect(homedir()).toBe(testHome);
  expect(process.env.HOME).toBe(testHome);
  expect(process.env.USERPROFILE).toBe(testHome);

  for (const key of [
    "LETTA_HOME",
    "LETTA_LOCAL_BACKEND_DIR",
    "LETTA_MEMORY_DIR",
    "MEMORY_DIR",
    "XDG_CONFIG_HOME",
  ]) {
    const value = process.env[key];
    if (!value || !isAbsolute(value)) continue;
    const child = relative(testHome, value);
    expect(
      child === "" || (!child.startsWith("..") && !isAbsolute(child)),
    ).toBe(true);
  }

  addRoute("slack", {
    accountId: "test-account",
    chatId: "test-chat",
    chatType: "channel",
    threadId: "test-thread",
    agentId: "test-agent",
    conversationId: "test-conversation",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const routingPath = getChannelRoutingPath("slack");
  expect(routingPath).toBe(
    join(testHome, ".letta", "channels", "slack", "routing.yaml"),
  );
  expect(existsSync(routingPath)).toBe(true);
  expect(readFileSync(routingPath, "utf-8")).toContain("test-conversation");
});

test("direct bun test preserves state outside its disposable home", () => {
  const operatorHome = mkdtempSync(join(tmpdir(), "letta-operator-home-"));
  const liveRoutePath = join(
    operatorHome,
    ".letta",
    "channels",
    "slack",
    "routing.yaml",
  );
  const liveMemoryDir = join(
    operatorHome,
    ".letta",
    "agents",
    "operator-agent",
    "memory",
  );
  const liveMemorySentinel = join(liveMemoryDir, "sentinel");
  const routeSentinel = '{"routes":[{"conversationId":"operator-route"}]}\n';

  try {
    mkdirSync(join(operatorHome, ".letta", "channels", "slack"), {
      recursive: true,
    });
    mkdirSync(liveMemoryDir, { recursive: true });
    writeFileSync(liveRoutePath, routeSentinel, "utf-8");
    writeFileSync(liveMemorySentinel, "operator-memory\n", "utf-8");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: operatorHome,
      USERPROFILE: operatorHome,
      MEMORY_DIR: liveMemoryDir,
    };
    delete env.LETTA_TEST_HOME;

    const fixturePath = join(
      process.cwd(),
      "src",
      "test-utils",
      "write-channel-route.test-fixture.ts",
    );
    const result = spawnSync(process.execPath, ["test", fixturePath], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(liveRoutePath, "utf-8")).toBe(routeSentinel);
    expect(readFileSync(liveMemorySentinel, "utf-8")).toBe("operator-memory\n");
    expect(existsSync(join(liveMemoryDir, "fixture-write"))).toBe(false);
  } finally {
    rmSync(operatorHome, { recursive: true, force: true });
  }
});
