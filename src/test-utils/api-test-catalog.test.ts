import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("API runner warms a shared cache for children with isolated homes and config", async () => {
  const root = await mkdtemp(join(tmpdir(), "letta-api-catalog-runner-"));
  const catalogModule = JSON.stringify(
    resolve("src/agent/remote-model-catalog.ts"),
  );
  const preload = join(root, "warm.ts");
  const fixture = join(root, "cache.test.ts");
  try {
    await writeFile(
      preload,
      `globalThis.fetch = async () => Response.json({ models: [{
        id: "auto", handle: "letta/auto", label: "Auto", brand: "letta",
        maxContextWindow: 140000, isDefault: true
      }] });`,
    );
    await writeFile(
      fixture,
      `import { expect, test } from "bun:test";
      test("isolated children survive catalog timeout", async () => {
        for (const name of ["first", "second"]) {
          const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
            globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
            const { settingsManager } = await import(${JSON.stringify(resolve("src/settings-manager.ts"))});
            await settingsManager.initialize();
            const { initializeModelCatalog } = await import(${catalogModule});
            await initializeModelCatalog();
          `)}], {
            env: { ...process.env, HOME: ${JSON.stringify(root)} + "/" + name,
              USERPROFILE: ${JSON.stringify(root)} + "/" + name,
              LETTA_CONFIG_DIR: ${JSON.stringify(root)} + "/config-" + name },
            stdout: "pipe", stderr: "pipe"
          });
          const stderr = await new Response(child.stderr).text();
          expect(await child.exited, stderr).toBe(0);
        }
      });`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "scripts/run-api-integration-tests.ts",
        fixture,
      ],
      {
        env: {
          ...process.env,
          LETTA_TEST_HOME: "",
          LETTA_API_KEY: "test-key",
          LETTA_BASE_URL: "https://api.letta.com",
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
