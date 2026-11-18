import {
  CallToolResultSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getRuntimeContext } from "@/runtime-context";
import { resolveMcpOriginatorToken } from "./mcp-originator-resolver";
import { getMcpSubprocessBrokerClientOrDefault } from "./mcp-subprocess-broker";
import type { UnifiedMcpClient } from "./unified-mcp";

const catalogSchema = z.object({
  serverName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  instructions: z.string(),
  tools: z.array(ToolSchema),
});
export type CloudToolCatalog = z.infer<typeof catalogSchema>;

export async function getCloudToolsClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UnifiedMcpClient> {
  if (resolveBackendMode() !== "api") {
    throw new Error("Caller-scoped API tools require the API backend");
  }
  const client = await getMcpSubprocessBrokerClientOrDefault(env);
  return {
    get: (path) => client.get(path),
    post: (path, options) => {
      const context = getRuntimeContext();
      const runId =
        context?.resolveMcpOriginatorSuperRunId?.() ??
        context?.mcpOriginatorSuperRunId;
      const token = runId ? resolveMcpOriginatorToken(runId) : undefined;
      return client.post(path, {
        ...options,
        ...(token
          ? {
              headers: {
                "x-letta-mcp-originator-token": token,
                "x-letta-mcp-originator-isolation": "1",
              },
            }
          : {}),
      });
    },
  };
}

export async function listCloudTools(
  client: UnifiedMcpClient,
): Promise<CloudToolCatalog> {
  return catalogSchema.parse(
    await client.post("/v1/subagent-tools/list", { body: {} }),
  );
}

export async function callCloudTool(
  client: UnifiedMcpClient,
  name: string,
  args: Record<string, unknown>,
) {
  return CallToolResultSchema.parse(
    await client.post("/v1/subagent-tools/call", {
      body: { name, arguments: args },
    }),
  );
}
