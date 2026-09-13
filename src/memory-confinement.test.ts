import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createMemoryConfinementLauncherWithAvailability } from "@/permissions/memory-confinement-launcher";
import { canonicalizeRoot } from "@/permissions/sandbox-policy";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";

describe("memory confinement launcher", () => {
  test("wraps a launcher with the fail-closed Seatbelt policy", () => {
    const memoryDir = join(
      homedir(),
      ".letta",
      "agents",
      "agent-self",
      "memory",
    );
    const result = createMemoryConfinementLauncherWithAvailability(
      {
        launcher: [process.execPath, "letta.js", "app-server"],
        env: { MEMORY_DIR: memoryDir, PATH: "/usr/bin" },
      },
      { backend: "seatbelt", reason: "test" },
    );

    expect(result.backend).toBe("seatbelt");
    expect(result.launcher[0]).toBe("/usr/bin/sandbox-exec");
    expect(result.launcher).toContain(process.execPath);
    expect(result.launcher).toContain(
      `-DWRITABLE_0=${canonicalizeRoot(memoryDir)}`,
    );
    expect(result.launcher).toContain(
      `-DWRITABLE_1=${canonicalizeRoot(join(dirname(memoryDir), "memory-worktrees"))}`,
    );
    expect(result.env.PATH).toBe("/usr/bin");
    expect(result.env[SANDBOX_ENV_VAR]).toBe("seatbelt");
  });

  test("includes relocated harness state roots", () => {
    const result = createMemoryConfinementLauncherWithAvailability(
      {
        launcher: ["node", "letta.js"],
        env: {
          MEMORY_DIR: "/state/memory",
          LETTA_LOCAL_BACKEND_DIR: "/state/local-backend",
          LETTA_TRANSCRIPT_ROOT: "/state/transcripts",
        },
      },
      { backend: "seatbelt", reason: "test" },
    );

    expect(result.launcher).toContain(
      `-DBASEWRITABLE_1=${canonicalizeRoot("/state/local-backend")}`,
    );
    expect(result.launcher).toContain(
      `-DBASEWRITABLE_2=${canonicalizeRoot("/state/transcripts")}`,
    );
  });

  test("fails closed without a memory root", () => {
    expect(() =>
      createMemoryConfinementLauncherWithAvailability(
        { launcher: ["node", "letta.js"], env: {} },
        { backend: "seatbelt", reason: "test" },
      ),
    ).toThrow("requires MEMORY_DIR or LETTA_MEMORY_DIR");
  });

  test("fails closed without a kernel sandbox backend", () => {
    expect(() =>
      createMemoryConfinementLauncherWithAvailability(
        {
          launcher: ["node", "letta.js"],
          env: { MEMORY_DIR: "/state/memory" },
        },
        { backend: null, reason: "unsupported host" },
      ),
    ).toThrow("Memory confinement is unavailable: unsupported host");
  });
});
