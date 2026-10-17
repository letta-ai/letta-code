import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureBackendMode } from "@/backend";
import { resolveBackendMode } from "@/backend/backend-mode";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
} from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";

const originalHome = process.env.HOME;
const originalLocalDir = process.env.LETTA_LOCAL_BACKEND_DIR;
const originalLocalFlag = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
const originalMode = resolveBackendMode();
const agentId = "agent-code-mode-test";
const serverPath = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);
let home: string;

beforeEach(async () => {
  await settingsManager.reset();
  home = mkdtempSync(join(tmpdir(), "code-mode-test-"));
  process.env.HOME = home;
  process.env.LETTA_LOCAL_BACKEND_DIR = join(home, "local");
  configureBackendMode("local");
  await settingsManager.initialize();
});

afterEach(async () => {
  clearCapturedToolExecutionContexts();
  await settingsManager.reset();
  configureBackendMode(originalMode);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalLocalDir === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalDir;
  if (originalLocalFlag === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  else process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalFlag;
  rmSync(home, { recursive: true, force: true });
});

async function run(
  code: string,
  mode: "unrestricted" | "strict" = "unrestricted",
  signal?: AbortSignal,
) {
  const { preparedToolContext } =
    await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
      clientToolAllowlist: ["CodeMode", "Read", "Write"],
      workingDirectory: home,
      permissionModeState: { mode },
      runtimeContext: {
        agentId,
        conversationId: "default",
        workingDirectory: home,
      },
    });
  return runWithRuntimeContext(
    {
      agentId,
      conversationId: "default",
      workingDirectory: home,
      toolContextId: preparedToolContext.contextId,
    },
    () =>
      executeTool(
        "CodeMode",
        { code, args: { path: join(home, "input.txt") } },
        {
          toolContextId: preparedToolContext.contextId,
          signal,
        },
      ),
  );
}

test("combines a real file read and MCP calls without Workflow metadata or model setup", async () => {
  writeFileSync(join(home, "input.txt"), "hello from a file");
  settingsManager.setMcpServers(agentId, [
    {
      name: "everything",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
    },
  ]);
  const result = await run(`
const [source, echoed] = await Promise.all([
  tools.Read({ file_path: args.path }),
  tools.mcp__everything__echo({ message: 'hello from MCP' }),
]);
const second = await tools.mcp__everything__echo({ message: echoed });
const schema = await describeTool('mcp__everything__echo');
const names = (await listTools()).map(t => t.name);
console.log('combined');
return {
  file: source.includes('hello from a file'), echoed, second,
  schema: schema.inputSchema.required,
  read: names.includes('Read'), hidden: names.includes('CodeMode'),
  excluded: [typeof tools.CodeMode, typeof tools.Workflow, typeof tools.Bash],
  orchestration: [typeof agent, typeof decide],
};`);
  expect(result.status).toBe("success");
  expect(JSON.parse(result.toolReturn as string)).toEqual({
    result: {
      file: true,
      echoed: "Echo: hello from MCP",
      second: "Echo: Echo: hello from MCP",
      schema: ["message"],
      read: true,
      hidden: false,
      excluded: ["undefined", "undefined", "undefined"],
      orchestration: ["undefined", "undefined"],
    },
    output: ["combined"],
  });
}, 15000);

test("strict-mode nested calls need approval and do not write", async () => {
  const result = await run(
    `return await tools.Write({ file_path: args.path, content: 'no' });`,
    "strict",
  );
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("needs approval");
  expect(existsSync(join(home, "input.txt"))).toBe(false);
});

test("explicit deny rules block nested calls even in unrestricted mode", async () => {
  mkdirSync(join(home, ".letta"), { recursive: true });
  writeFileSync(
    join(home, ".letta", "settings.local.json"),
    JSON.stringify({ permissions: { deny: ["Write"] } }),
  );
  const result = await run(
    `return await tools.Write({ file_path: args.path, content: 'no' });`,
  );
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("denied by permission rules");
  expect(existsSync(join(home, "input.txt"))).toBe(false);
});

test("scripts can catch actual tool failures and continue", async () => {
  const result = await run(`
const results = await Promise.allSettled([tools.Read({ file_path: args.path })]);
return results.map(r => r.status);`);
  expect(result.status).toBe("success");
  expect(JSON.parse(result.toolReturn as string).result).toEqual(["rejected"]);
});

test("invalid JavaScript returns an error rather than running tools", async () => {
  const result = await run("return await ;");
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("CodeMode script failed to parse");
});

test("an aborted invocation does not launch nested writes", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await run(
    `return await tools.Write({ file_path: args.path, content: 'no' });`,
    "unrestricted",
    controller.signal,
  );
  expect(result.status).toBe("error");
  expect(existsSync(join(home, "input.txt"))).toBe(false);
});
