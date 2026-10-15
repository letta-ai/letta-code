import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "letta-mcp-entry-"));
  await mkdir(join(home, ".letta"));
  await writeFile(
    join(home, ".letta", "settings.json"),
    JSON.stringify({
      preferredBackendMode: "local",
      agents: [
        {
          agentId: "agent-local-mcp",
          baseUrl: `local:${join(home, "backend")}`,
          mcpServers: [
            {
              name: "everything",
              transport: "stdio",
              command: process.execPath,
              args: [
                join(
                  root,
                  "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
                ),
              ],
            },
          ],
        },
      ],
    }),
  );
});
afterAll(async () => rm(home, { recursive: true, force: true }));

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  measure = false,
) {
  const probe =
    'import {writeSync} from "node:fs"; process.on("exit", () => writeSync(2, "PEAK_RSS_KIB=" + process.resourceUsage().maxRSS + "\\n"));';
  const child = Bun.spawn(
    [
      bundle ? "node" : process.execPath,
      ...(measure
        ? ["--import", `data:text/javascript,${encodeURIComponent(probe)}`]
        : []),
      bundle || "src/standalone-entry.ts",
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LETTA_LOCAL_BACKEND_DIR: join(home, "backend"),
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: undefined,
        LETTA_BASE_URL: "https://api.letta.com",
        LETTA_API_KEY: "",
        AGENT_ID: undefined,
        LETTA_AGENT_ID: undefined,
        LETTA_CODE_AGENT_ROLE: undefined,
        LETTA_PARENT_AGENT_ID: undefined,
        LETTA_DESKTOP_CREDENTIALS_IPC: undefined,
        LETTA_DEBUG: "0",
        LETTA_CODE_TELEM: "0",
        LETTA_DISABLE_MODS: "1",
        ...env,
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
  return { stdout, stderr, code };
}

test("explicit API mode overrides saved local mode and keeps MCP argument errors", async () => {
  const help = await cli(["--backend", "api", "mcp", "--help"]);
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).toContain("letta mcp call");
  const missingAgent = await cli(["mcp", "list", "--backend=api"]);
  expect(missingAgent.code).toBe(1);
  expect(JSON.parse(missingAgent.stderr).error.code).toBe("agent_id_required");
  const invalidArgs = await cli(["mcp", "--backend", "api", "--unknown"]);
  expect(invalidArgs.code).toBe(1);
  expect(JSON.parse(invalidArgs.stderr).error.code).toBe("mcp_error");
});

test.each([{ prefix: [] }, { prefix: ["--backend", "local"] }])(
  "local MCP still calls a real stdio server with %j",
  async ({ prefix }) => {
    const result = await cli([
      ...prefix,
      "mcp",
      "call",
      "mcp__everything__echo",
      "--agent",
      "agent-local-mcp",
      "--args",
      '{"message":"entrypoint echo"}',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).content).toEqual([
      { type: "text", text: "Echo: entrypoint echo" },
    ]);
  },
  20_000,
);

test.skipIf(!bundle || process.platform !== "linux")(
  "built MCP startup does not load the full agent runtime",
  async () => {
    const result = await cli(
      ["mcp", "--help"],
      { LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0" },
      true,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("letta mcp call");
    const peak = Number(result.stderr.match(/PEAK_RSS_KIB=(\d+)/)?.[1]);
    // The regression loaded ~200 MiB before making any request. Leave ample
    // headroom over the lightweight path's ~85 MiB, including CI variance.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(150 * 1024);
  },
);
