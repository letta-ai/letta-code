import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";

describe("local agent storage", () => {
  test("skips and quarantines an unreadable agent record instead of failing to load", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-corrupt-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Survivor",
      } as never);

      const emptyRecord = join(storageDir, "agents", "empty.json");
      await writeFile(emptyRecord, "");

      const reloaded = new LocalBackend({ storageDir, memfsEnabled: false });
      await expect(reloaded.retrieveAgent(agent.id)).resolves.toMatchObject({
        id: agent.id,
        name: "Survivor",
      });
      expect(existsSync(emptyRecord)).toBe(false);
      expect(existsSync(`${emptyRecord}.corrupt`)).toBe(true);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
