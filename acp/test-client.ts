#!/usr/bin/env bun
/**
 * Minimal ACP client that spawns the letta-acp agent over stdio and runs a
 * prompt turn against it, printing session updates as they stream.
 *
 * Usage:
 *   bun test-client.ts                      # default smoke prompt
 *   bun test-client.ts "your prompt here"   # custom prompt
 *
 * Env:
 *   ACP_TEST_REJECT=1          reject permission requests instead of allowing
 *   ACP_TEST_CANCEL_AFTER=ms   send session/cancel this long after prompting
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const promptText =
  process.argv[2] ??
  "Reply with exactly the text LETTA_ACP_OK and nothing else.";

const agentPath = join(import.meta.dir, "src", "index.ts");
const child = spawn("bun", [agentPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
);

let sawAgentText = false;

try {
  await acp
    .client({ name: "letta-acp-test-client" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const optionId = process.env.ACP_TEST_REJECT
        ? "reject_once"
        : "allow_once";
      console.log(`\n[permission] ${ctx.params.toolCall.title} -> ${optionId}`);
      return {
        outcome: { outcome: "selected" as const, optionId },
      };
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") {
            sawAgentText = true;
            process.stdout.write(update.content.text);
          }
          break;
        case "agent_thought_chunk":
          if (update.content.type === "text") {
            console.log(`\n[thought] ${update.content.text}`);
          }
          break;
        case "tool_call":
          console.log(`\n[tool_call] ${update.title} (${update.status})`);
          break;
        case "tool_call_update":
          console.log(
            `[tool_call_update] ${update.toolCallId}: ${update.status}`,
          );
          break;
        default:
          console.log(`\n[${update.sessionUpdate}]`);
          break;
      }
    })
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      console.log(
        `[init] negotiated protocol v${init.protocolVersion}, capabilities: ${JSON.stringify(init.agentCapabilities)}`,
      );

      const session = await ctx.request(acp.methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      });
      console.log(`[session] ${session.sessionId}`);

      console.log(`[prompt] ${promptText}\n`);
      const cancelAfter = Number(process.env.ACP_TEST_CANCEL_AFTER ?? 0);
      if (cancelAfter > 0) {
        setTimeout(() => {
          console.log(
            `\n[cancel] sending session/cancel after ${cancelAfter}ms`,
          );
          void ctx.notify(acp.methods.agent.session.cancel, {
            sessionId: session.sessionId,
          });
        }, cancelAfter);
      }
      const result = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
      console.log(`\n\n[done] stopReason: ${result.stopReason}`);

      if (cancelAfter > 0) {
        if (result.stopReason !== "cancelled") {
          throw new Error(
            `Cancel test failed: expected stopReason=cancelled, got ${result.stopReason}`,
          );
        }
        console.log("[ok] ACP cancel test passed");
        return;
      }
      if (result.stopReason !== "end_turn" || !sawAgentText) {
        throw new Error(
          `Smoke test failed: stopReason=${result.stopReason}, sawAgentText=${sawAgentText}`,
        );
      }
      console.log("[ok] ACP smoke test passed");
    });
} finally {
  child.kill();
}
process.exit(0);
