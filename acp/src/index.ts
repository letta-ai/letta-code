#!/usr/bin/env bun
/**
 * letta-acp — ACP v1 agent adapter for Letta.
 *
 * Speaks the Agent Client Protocol over stdio (newline-delimited JSON-RPC),
 * backed by a Letta agent via @letta-ai/letta-agent-sdk.
 *
 * Environment:
 *   LETTA_ACP_BACKEND          local (default) | remote | cloud
 *   LETTA_APP_SERVER_URL       remote backend URL (default ws://127.0.0.1:4500)
 *   LETTA_APP_SERVER_TOKEN     remote backend auth token
 *   LETTA_API_KEY              cloud backend API key
 *   LETTA_AGENT_ID             reuse an existing agent (recommended)
 *   LETTA_ACP_MODEL            model override for sessions
 *   LETTA_ACP_PERMISSION_MODE  standard (default) | acceptEdits | unrestricted
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { LettaAcpAgent } from "./agent.js";
import { configFromEnv } from "./config.js";

const agent = new LettaAcpAgent(configFromEnv());

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);

const connection = await acp
  .agent({ name: "letta-acp" })
  .onRequest(acp.methods.agent.initialize, (ctx) =>
    agent.initialize(ctx.params),
  )
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, (ctx) =>
    agent.newSession(ctx.params),
  )
  .onRequest(acp.methods.agent.session.prompt, (ctx) =>
    agent.prompt(ctx.params, ctx.client),
  )
  .onNotification(acp.methods.agent.session.cancel, (ctx) =>
    agent.cancel(ctx.params),
  )
  .connect(stream);

await connection.closed;
agent.shutdown();
process.exit(0);
