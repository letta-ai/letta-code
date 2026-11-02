// Real installed CLIs; discovery sends no inference requests and needs no API keys.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const worker of ["claude-code", "codex", "opencode"]) {
  for (const missing of [false, true]) {
    test(`${worker} discovery ${missing ? "fails without its executable" : "returns native selectable IDs"}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "letta-worker-models-"));
      try {
        await mkdir(join(home, "codex"));
        const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
        const child = Bun.spawn(
          [
            bundle ? (Bun.which("node") ?? "node") : process.execPath,
            bundle || "src/index.ts",
            "model",
            "list",
            "--worker",
            worker,
          ],
          {
            cwd: resolve(import.meta.dir, "../../.."),
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              XDG_CONFIG_HOME: join(home, "config"),
              XDG_DATA_HOME: join(home, "data"),
              XDG_STATE_HOME: join(home, "state"),
              XDG_CACHE_HOME: join(home, "cache"),
              CODEX_HOME: join(home, "codex"),
              CLAUDE_CONFIG_DIR: join(home, "claude"),
              AGENT_ID: undefined,
              LETTA_AGENT_ID: undefined,
              CONVERSATION_ID: undefined,
              LETTA_API_KEY: undefined,
              // Resolve the test runner before hiding the native worker executables.
              ...(missing ? { PATH: home } : {}),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (missing) {
          expect(code).not.toBe(0);
          expect(stdout.trim()).toBe("");
          expect(stderr).not.toContain("Unhandled");
        } else {
          expect(code, stderr).toBe(0);
          const result = JSON.parse(stdout);
          expect(result).toMatchObject({ worker, computer: "local" });
          expect(result.models.length).toBeGreaterThan(0);
          for (const model of result.models) {
            expect(model.id.length).toBeGreaterThan(0);
            expect(model.display_name.length).toBeGreaterThan(0);
            if (worker === "opencode") expect(model.id).toContain("/");
          }
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);
  }
}
