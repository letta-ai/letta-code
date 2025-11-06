#!/usr/bin/env bun
/**
 * Simplest possible example: Send an image to a Letta agent with streaming
 */

import { readFileSync } from "node:fs";
import { sendMessageStream } from "../src/agent/message";

async function main() {
  const agentId = "agent-YOUR-AGENT-ID"; // Replace with your agent ID
  const imagePath = "./screenshot.png"; // Replace with your image path

  // 1. Read and encode image
  const imageData = readFileSync(imagePath).toString("base64");

  // 2. Send message with streaming
  const stream = await sendMessageStream(agentId, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "What's in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            mediaType: "image/png",
            data: imageData,
          },
        },
      ],
    },
  ]);

  // 3. Print streaming response
  console.log("Agent response:");
  for await (const chunk of stream) {
    if (chunk.messageType === "assistant_message") {
      process.stdout.write(chunk.content || "");
    }
  }
  console.log("\n");
}

main().catch(console.error);
