#!/usr/bin/env bun
/**
 * Quick sanity check: create an agent, send a message, log streamed output.
 */

import { createAgent } from "../agent/create";
import { sendMessageStream } from "../agent/message";

async function main() {
  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) {
    console.error("❌  Missing LETTA_API_KEY in env");
    process.exit(1);
  }

  console.log("🧠  Creating test agent...");
  const agent = await createAgent("smoke-agent", "openai/gpt-4.1");
  console.log(`✅  Agent created: ${agent.id}`);

  console.log("💬  Sending test message...");
  const stream = await sendMessageStream(agent.id, [
    {
      role: "user",
      content: "Hello from Bun smoke test! Try calling a tool.",
    },
  ]);

  // Print every chunk as it arrives
  for await (const chunk of stream) {
    const type = chunk.message_type ?? "unknown";

    switch (chunk.message_type) {
      case "reasoning_message": {
        const run = chunk.run_id
          ? `run=${chunk.run_id}:${chunk.seq_id ?? "-"} `
          : "";
        process.stdout.write(
          `[reasoning] ${run}${JSON.stringify(chunk) ?? ""}\n`,
        );
        break;
      }
      case "assistant_message": {
        const run = chunk.run_id
          ? `run=${chunk.run_id}:${chunk.seq_id ?? "-"} `
          : "";
        process.stdout.write(
          `[assistant] ${run}${JSON.stringify(chunk) ?? ""}\n`,
        );
        break;
      }
      case "tool_call_message": {
        const run = chunk.run_id
          ? `run=${chunk.run_id}:${chunk.seq_id ?? "-"} `
          : "";
        process.stdout.write(
          `[tool_call] ${run}${JSON.stringify(chunk) ?? ""}\n`,
        );
        break;
      }
      case "tool_return_message": {
        const run = chunk.run_id
          ? `run=${chunk.run_id}:${chunk.seq_id ?? "-"} `
          : "";
        process.stdout.write(`[tool_return] ${run}${chunk}\n`);
        break;
      }
      case "approval_request_message": {
        const run = chunk.run_id
          ? `run=${chunk.run_id}:${chunk.seq_id ?? "-"} `
          : "";
        process.stdout.write(
          `[approval_request] ${run}${JSON.stringify(chunk)}\n`,
        );
        break;
      }
      case "ping":
        // keepalive ping, ignore
        break;
      default:
        process.stdout.write(`[event:${type}] ${JSON.stringify(chunk)}\n`);
    }
  }

  console.log("\n✅  Stream ended cleanly");
}

main().catch((err) => {
  console.error("❌  Smoke test failed:", err);
  process.exit(1);
});
