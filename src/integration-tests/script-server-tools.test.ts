import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { settingsManager } from "@/settings-manager";
import { createScriptToolScope } from "@/tools/script-tool-scope";
import { executeToolScript } from "@/tools/workflow/workflow-engine";

// The CI API integration matrix provides LETTA_API_KEY; a missing key is a
// configuration failure, not a reason to skip live endpoint coverage.
test("CodeMode and Monitor scripts call tools Letta Cloud executes", async () => {
  if (!process.env.LETTA_API_KEY) {
    throw new Error("LETTA_API_KEY is required for the live server-tool test.");
  }
  await settingsManager.initialize();
  const client = new Letta({
    apiKey: process.env.LETTA_API_KEY,
    baseURL: process.env.LETTA_BASE_URL || "https://api.letta.com",
    timeout: 120000,
  });
  const agent = await client.agents.create({
    name: "Script server-tool integration",
    agent_type: "letta_v1_agent",
    model: "letta/auto",
    include_base_tools: false,
    include_base_tool_rules: false,
    tools: ["fetch_webpage"],
    initial_message_sequence: [],
  });
  try {
    const scope = await createScriptToolScope(agent.id);
    try {
      expect(scope.builtinToolNames).toContain("fetch_webpage");
      const page = await executeToolScript({
        ...scope,
        script: `const listed = (await listTools()).map((t) => t.name);
const page = JSON.parse(await tools.fetch_webpage({ url: "https://example.com" }));
let error;
try { await tools.fetch_webpage({}); } catch (e) { error = String(e); }
return { listed, title: page.title, error };`,
      });
      expect(page).toMatchObject({
        title: "Example Domain",
        error: expect.stringContaining("url is required"),
      });
      expect((page as { listed: string[] }).listed).toContain("fetch_webpage");
    } finally {
      await scope.cleanup();
    }

    // A server tool that needs approval stays out of scripts.
    const gatedName = `script_gated_${crypto.randomUUID().replaceAll("-", "")}`;
    const gatedTool = await client.tools.create({
      source_code: `def ${gatedName}() -> str:
    """Returns a fixed string."""
    return "ran"
`,
      default_requires_approval: true,
    });
    try {
      await client.agents.tools.attach(gatedTool.id, { agent_id: agent.id });
      const gated = await createScriptToolScope(agent.id);
      try {
        await expect(gated.callTool(gatedName, {})).rejects.toThrow(
          "needs approval",
        );
      } finally {
        await gated.cleanup();
      }
    } finally {
      await client.tools.delete(gatedTool.id);
    }
  } finally {
    await client.agents.delete(agent.id);
  }
}, 120000);
