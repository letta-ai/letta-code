import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIBackend } from "@/backend/backend";
import {
  clientSkillsBackendIdentity,
  pruneBaselineFiles,
} from "./client-skills-baseline-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("client_skills baseline store", () => {
  test("backend identity separates local stores from API servers", () => {
    const localA = { getLocalStorageDir: () => "/tmp/store-a" };
    const localB = { getLocalStorageDir: () => "/tmp/store-b" };
    expect(clientSkillsBackendIdentity(localA)).toBe("local:/tmp/store-a");
    expect(clientSkillsBackendIdentity(localB)).not.toBe(
      clientSkillsBackendIdentity(localA),
    );
    const api = clientSkillsBackendIdentity(new APIBackend());
    expect(typeof api).toBe("string");
    expect(api).not.toStartWith("local:");
    // Fakes with no durable identity stay in memory only.
    expect(clientSkillsBackendIdentity({})).toBeNull();
  });

  test("pruning drops stale files and caps the namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "client-skills-prune-"));
    dirs.push(dir);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const touch = (name: string, ageMs: number) => {
      const path = join(dir, name);
      writeFileSync(path, "{}");
      const at = new Date(now - ageMs);
      utimesSync(path, at, at);
    };
    touch("stale.json", 31 * day);
    touch("old.tmp", 2 * day);
    touch("fresh.tmp", 1000);
    for (let i = 0; i < 502; i++) touch(`f${i}.json`, i * 1000);
    pruneBaselineFiles(dir, now);
    const left = new Set(readdirSync(dir));
    expect(left.has("stale.json")).toBe(false);
    expect(left.has("old.tmp")).toBe(false);
    expect(left.has("fresh.tmp")).toBe(true);
    // The two least recently written baselines were dropped.
    expect(left.has("f501.json")).toBe(false);
    expect(left.has("f500.json")).toBe(false);
    expect(left.has("f499.json")).toBe(true);
    expect(left.size).toBe(501);
  });
});
