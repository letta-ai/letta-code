import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";

describe("local agent storage", () => {
  test("ignores macOS AppleDouble sidecars when loading agents", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-appledouble-"),
    );

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "AppleDouble test",
      } as never);
      const agentsDir = join(storageDir, "agents");
      const agentFile = (await readdir(agentsDir)).find((file) =>
        file.endsWith(".json"),
      );
      expect(agentFile).toBeDefined();
      if (!agentFile) throw new Error("Expected a persisted agent record");

      await writeFile(
        join(agentsDir, `._${agentFile}`),
        Buffer.from([
          0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61, 0x63,
          0x20, 0x4f, 0x53, 0x20, 0x58,
        ]),
      );

      const reloaded = new LocalBackend({
        storageDir,
        memfsEnabled: false,
      });
      await expect(reloaded.retrieveAgent(agent.id)).resolves.toMatchObject({
        id: agent.id,
        name: "AppleDouble test",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
