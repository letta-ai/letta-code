import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitMemoryWrite,
  initializeLocalMemoryRepo,
} from "@/agent/memory-git";

/**
 * Local-sync memory commits used to rewrite `.git/config` three times on
 * every commit (`letta.agentId`, `user.email`, `user.name`), even when the
 * values were already correct. A failure in any of those writes failed the
 * whole memory write. These tests run real git against a temp repo and use
 * GIT_TRACE to record every git invocation the commit path makes.
 */

const AGENT_ID = "agent-local-config-writes-test";
const AUTHOR = {
  agentId: AGENT_ID,
  authorName: "Tutor",
  authorEmail: `${AGENT_ID}@letta.com`,
};
const persona = (body: string) =>
  `---\ndescription: Agent persona\n---\n${body}\n`;
const IDENTITY_KEYS = ["letta.agentId", "user.email", "user.name"];

let tempDir: string;
let memoryDir: string;
let tracePath: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "memory-git-config-writes-"));
  const globalConfigPath = join(tempDir, "gitconfig");
  writeFileSync(globalConfigPath, "", "utf-8");
  setEnv("GIT_CONFIG_GLOBAL", globalConfigPath);
  setEnv("GIT_TRACE", undefined);

  memoryDir = join(tempDir, "memory");
  await initializeLocalMemoryRepo({
    memoryDir,
    agentId: AGENT_ID,
    authorName: AUTHOR.authorName,
    files: [{ relativePath: "system/persona.md", content: persona("v0") }],
  });
  tracePath = join(tempDir, "git-trace.log");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete savedEnv[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** Run a local-sync memory commit and return the git commands it ran. */
async function tracedCommit(
  content: string,
  author: typeof AUTHOR,
): Promise<string[]> {
  writeFileSync(
    join(memoryDir, "system", "persona.md"),
    persona(content),
    "utf-8",
  );
  rmSync(tracePath, { force: true });
  setEnv("GIT_TRACE", tracePath);
  try {
    const result = await commitMemoryWrite({
      memoryDir,
      pathspecs: ["system/persona.md"],
      reason: `write ${content}`,
      author,
      syncMode: "local",
    });
    expect(result.committed).toBe(true);
  } finally {
    setEnv("GIT_TRACE", undefined);
  }
  expect(existsSync(tracePath)).toBe(true);
  return readFileSync(tracePath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.includes("trace: built-in: git"));
}

function configWrites(commands: string[]): string[] {
  return commands.filter(
    (line) =>
      / config /.test(line) &&
      !/ --get /.test(line) &&
      IDENTITY_KEYS.some((key) => line.includes(` ${key} `)),
  );
}

function localConfig(key: string): string {
  return execFileSync("git", ["config", "--local", "--get", key], {
    cwd: memoryDir,
    encoding: "utf-8",
  }).trim();
}

describe("local-sync memory commit git config writes", () => {
  test("a commit with unchanged identity makes no git config writes", async () => {
    await tracedCommit("v1", AUTHOR);
    const commands = await tracedCommit("v2", AUTHOR);

    // The trace did capture the commit itself, so an empty write list is
    // not an artifact of tracing being off.
    expect(commands.some((line) => / commit /.test(line))).toBe(true);
    expect(configWrites(commands)).toEqual([]);
  });

  test("a changed author email is still written to local config", async () => {
    await tracedCommit("v1", AUTHOR);
    const newEmail = "renamed-agent@letta.com";
    const commands = await tracedCommit("v2", {
      ...AUTHOR,
      authorEmail: newEmail,
    });

    const writes = configWrites(commands);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(" user.email ");
    expect(localConfig("user.email")).toBe(newEmail);
    expect(localConfig("user.name")).toBe(AUTHOR.authorName);
    expect(localConfig("letta.agentId")).toBe(AGENT_ID);
  });
});
