import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";

function listedNames(page: unknown): string[] {
  const items = (page as { items?: Array<{ name: string }> }).items;
  return Array.isArray(items) ? items.map((agent) => agent.name) : [];
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("local agent listing", () => {
  test("filters by exact, case-sensitive agent name", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-agent-list-name-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const target = await backend.createAgent({ name: "Alpha" } as never);
      await tick();
      await backend.createAgent({ name: "Beta" } as never);
      await tick();
      await backend.createAgent({ name: "Gamma" } as never);

      // Sanity check: the target is not the most recent agent.
      expect(
        listedNames(await backend.listAgents({ limit: 1 } as never)),
      ).not.toEqual(["Alpha"]);

      const byName = await backend.listAgents({ name: "Alpha" } as never);
      expect(listedNames(byName)).toEqual(["Alpha"]);
      expect(
        (byName as unknown as { items: Array<{ id: string }> }).items[0]?.id,
      ).toBe(target.id);

      expect(
        listedNames(
          await backend.listAgents({ name: "Alpha", limit: 1 } as never),
        ),
      ).toEqual(["Alpha"]);

      expect(
        listedNames(await backend.listAgents({ name: "alpha" } as never)),
      ).toEqual([]);
      expect(
        listedNames(await backend.listAgents({ name: "Missing" } as never)),
      ).toEqual([]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
