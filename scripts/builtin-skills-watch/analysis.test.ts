import { describe, expect, test } from "bun:test";
import {
  buildAnalysis,
  collectSkillFilesAtCommit,
  listBuiltinSkillsAtCommit,
} from "./analysis.ts";

const HEAD = gitHead();
const AUDIT_AT = "2026-08-26T00:00:00.000Z";

describe("bundled skill inventory", () => {
  test("lists bundled skill directories from an exact commit", () => {
    const skills = listBuiltinSkillsAtCommit(HEAD);

    expect(skills).toContain("creating-skills");
    expect(skills).toContain("syncing-memory-filesystem");
    expect(skills).toEqual([...skills].sort());
    expect(new Set(skills).size).toBe(skills.length);
  });

  test("includes every tracked file in the selected skill digest", () => {
    const files = collectSkillFilesAtCommit(HEAD, "creating-skills");

    expect(files).toContain("src/skills/builtin/creating-skills/SKILL.md");
    expect(files.some((path) => path.includes("/scripts/"))).toBe(true);
  });
});

describe("buildAnalysis", () => {
  test("builds a reproducible exact-commit candidate", () => {
    const first = buildAnalysis({
      skill: "syncing-memory-filesystem",
      currentSha: HEAD,
      auditAt: AUDIT_AT,
    });
    const second = buildAnalysis({
      skill: "syncing-memory-filesystem",
      currentSha: HEAD,
      auditAt: AUDIT_AT,
    });

    expect(second).toEqual(first);
    expect(first.candidate_id).toStartWith(
      `syncing-memory-filesystem@${HEAD.slice(0, 12)}-`,
    );
    expect(first.skill_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.skill_files).toContain(
      "src/skills/builtin/syncing-memory-filesystem/SKILL.md",
    );
    expect(first.skill_inventory).toContain("syncing-memory-filesystem");
  });

  test("rejects an unknown skill", () => {
    expect(() =>
      buildAnalysis({
        skill: "not-a-bundled-skill",
        currentSha: HEAD,
        auditAt: AUDIT_AT,
      }),
    ).toThrow("does not exist");
  });
});

function gitHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Could not resolve HEAD");
  return result.stdout.toString().trim();
}
