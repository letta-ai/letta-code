#!/usr/bin/env bun
/**
 * Minimal example: Send an image to a Letta agent
 *
 * Usage:
 *   bun examples/send-image.ts <agent-id> <image-path>
 *
 * Example:
 *   bun examples/send-image.ts agent-123abc screenshot.png
 */

import { readFileSync } from "node:fs";
import { getClient } from "../src/agent/client";
import { sendMessageStream } from "../src/agent/message";

async function main() {
  const agentId = process.argv[2];
  const imagePath = process.argv[3];

  if (!agentId || !imagePath) {
    console.error("Usage: bun send-image.ts <agent-id> <image-path>");
    process.exit(1);
  }

  // Step 1: Read image file and convert to base64
  const imageBuffer = readFileSync(imagePath);
  const base64Data = imageBuffer.toString("base64");

  // Determine media type from file extension
  const ext = imagePath.toLowerCase();
  const mediaType = ext.endsWith(".png")
    ? "image/png"
    : ext.endsWith(".jpg") || ext.endsWith(".jpeg")
      ? "image/jpeg"
      : ext.endsWith(".gif")
        ? "image/gif"
        : ext.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg"; // default

  console.log(`Sending ${imagePath} to agent ${agentId}...`);

  // Step 2: Create message content with text and image
  const messageContent = [
    { type: "text" as const, text: "What do you see in this image?" },
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        mediaType,
        data: base64Data,
      },
    },
  ];

  // Step 3: Send message to agent
  const stream = await sendMessageStream(agentId, [
    {
      role: "user",
      content: messageContent,
    },
  ]);

  // Step 4: Process the streaming response
  console.log("\nAgent response:");
  for await (const chunk of stream) {
    if (chunk.messageType === "assistant_message") {
      process.stdout.write(chunk.content || "");
    } else if (chunk.messageType === "reasoning_message") {
      // Optionally show internal monologue
      // console.log(`[thinking] ${chunk.reasoning}`);
    }
  }

  console.log("\n");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
