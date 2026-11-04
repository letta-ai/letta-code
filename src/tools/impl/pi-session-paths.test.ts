import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNativeSessionPath } from "./native-session-capture";
import { findPiSessionPath, piSessionRoots } from "./pi-session-paths";

const ID = "0190f5c2-6c1e-7b3a-9f4e-1a2b3c4d5e6f";
const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-pi-paths-"));
  dirs.push(dir);
  return dir;
}
function session(root: string, project: string | null): string {
  const dir = project ? join(root, project) : root;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-11-04T01-40-04-185Z_${ID}.jsonl`);
  writeFileSync(path, "{}\n");
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("pi session paths", () => {
  test("finds a session under the default per-directory layout", async () => {
    const home = temp();
    const path = session(join(home, ".pi", "agent", "sessions"), "--repo--");
    const env = { HOME: home };
    expect(await findPiSessionPath(ID, env)).toBe(path);
    expect(await findNativeSessionPath("pi", ID, env)).toBe(path);
  });

  test("honors PI_CODING_AGENT_DIR, the sessionDir setting and the env override", async () => {
    const agentDir = temp();
    const configured = temp();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: configured }),
    );
    const override = temp();
    const env = {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: override,
    };
    expect(await piSessionRoots(env)).toEqual([
      override,
      configured,
      join(agentDir, "sessions"),
    ]);
    const flat = session(configured, null);
    expect(await findPiSessionPath(ID, env)).toBe(flat);
  });

  test("returns undefined for unknown or malformed IDs", async () => {
    const env = { HOME: temp() };
    expect(await findPiSessionPath(ID, env)).toBeUndefined();
    expect(await findPiSessionPath("../etc/passwd", env)).toBeUndefined();
  });
});
