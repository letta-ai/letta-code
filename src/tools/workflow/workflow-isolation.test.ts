import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run the regression in a disposable process: the old implementation either
// exits on an unhandled rejection or blocks its event loop indefinitely.
const runner = new URL("./workflow-runner.ts", import.meta.url).href;
const bundled = mkdtempSync(join(tmpdir(), "workflow-node-test-"));

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(runner),
      fileURLToPath(new URL("./workflow-worker.ts", import.meta.url)),
    ],
    outdir: bundled,
    target: "node",
    format: "esm",
    naming: "[name].js",
  });
  expect(build.success).toBe(true);
});
afterAll(() => rmSync(bundled, { recursive: true, force: true }));

function runIsolated(runtime: "bun" | "node", body: string) {
  const entry =
    runtime === "bun"
      ? runner
      : pathToFileURL(join(bundled, "workflow-runner.js")).href;
  const preamble = `
  import { runWorkflow } from ${JSON.stringify(entry)};
  import { mkdtempSync, rmSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';
  const executionsDir = mkdtempSync(join(tmpdir(), 'workflow-isolation-'));
  const meta = 'export const meta = {name:"isolated",description:"isolated"};';
`;
  return spawnSync(
    runtime === "bun" ? process.execPath : "node",
    ["--input-type=module", "--eval", preamble + body],
    {
      encoding: "utf8",
      timeout: 4000,
      killSignal: "SIGKILL",
    },
  );
}

describe.each(["bun", "node"] as const)(
  "workflow host isolation (%s)",
  (runtime) => {
    test("a detached agent call cannot terminate the host", () => {
      const child = runIsolated(
        runtime,
        `
      let aborted = false;
      const result = await runWorkflow(async (_, signal) => {
        await new Promise(resolve => signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }, {once:true}));
        return {value:null,failed:true};
      }, {script:meta+'agent("work"); return 42;', executionsDir});
      await new Promise(resolve => setTimeout(resolve, 30));
      console.log(JSON.stringify({result:result.result,aborted}));
      rmSync(executionsDir,{recursive:true,force:true});
    `,
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toContain('"result":42,"aborted":true');
    });

    test("the host can abort a CPU loop after an await", () => {
      const child = runIsolated(
        runtime,
        `
      const controller = new AbortController();
      try {
        await runWorkflow(async () => ({value:'ok',failed:false}), {
          script:meta+'await sleep(1); log("loop"); while(true) {}',
          executionsDir, signal:controller.signal,
          onProgress(event) {
            if(event.kind==='log' && event.message==='loop') {
              setTimeout(() => controller.abort(), 20);
            }
          },
        });
      } catch (error) {
        console.log(error.message);
      }
      const next = await runWorkflow(async () => ({value:'ok',failed:false}), {
        script:meta+'return 7;', executionsDir,
      });
      console.log('host survived',next.result);
      rmSync(executionsDir,{recursive:true,force:true});
    `,
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toContain("Workflow aborted");
      expect(child.stdout).toContain("host survived 7");
    }, 6000);
  },
);
