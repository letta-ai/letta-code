import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("standalone bundle resolves statically embedded OAuth flows", async () => {
  const tempDir = await mkdtemp(join(projectRoot, ".standalone-oauth-test-"));
  tempDirs.push(tempDir);
  const probePath = join(tempDir, "oauth-probe.ts");
  const outputPath = join(tempDir, "oauth-probe.js");

  await writeFile(
    probePath,
    `import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const oauth = openaiCodexProvider().auth.oauth;
if (!oauth) throw new Error("OpenAI Codex OAuth is unavailable");
const auth = await oauth.toAuth({
  type: "oauth",
  access: "standalone-oauth-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "account-id",
});
console.log(auth.apiKey);
`,
  );

  const result = await Bun.build({
    entrypoints: [join(projectRoot, "src/standalone-entry.ts")],
    outdir: tempDir,
    naming: { entry: "oauth-probe.js" },
    target: "node",
    format: "esm",
    plugins: [
      {
        name: "standalone-oauth-probe",
        setup(build) {
          build.onResolve({ filter: /^\.\/index$/ }, ({ importer }) => {
            if (importer.endsWith("standalone-entry.ts")) {
              return { path: probePath };
            }
            return undefined;
          });
        },
      },
    ],
  });
  expect(result.success).toBe(true);

  const execution = spawnSync("node", [outputPath], {
    cwd: tempDir,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (execution.status !== 0) {
    throw new Error(
      `Standalone OAuth probe failed with status ${execution.status}\nstdout:\n${execution.stdout}\nstderr:\n${execution.stderr}`,
    );
  }
  expect(execution.stderr).toBe("");
  expect(execution.stdout.trim()).toBe("standalone-oauth-token");
});
