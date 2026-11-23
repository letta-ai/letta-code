import { readFileSync, writeFileSync } from "node:fs";
import { createAgent } from "@/agent/create";
import { sendMessageStream } from "@/agent/message";
import { getClient } from "@/backend/api/client";

async function main() {
  const testImageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const testImagePath = "/tmp/test.png";
  writeFileSync(testImagePath, Buffer.from(testImageBase64, "base64"));
  console.log("Created test image at", testImagePath);

  const client = await getClient();

  console.log("\nCreating test agent...");
  const { agent } = await createAgent("image-test-agent");
  console.log("Agent created:", agent.id);

  console.log("Creating conversation...");
  const conversation = await client.conversations.create({
    agent_id: agent.id,
  });
  console.log("Conversation created:", conversation.id);

  const imageData = readFileSync(testImagePath).toString("base64");

  console.log("\nSending image to agent...");
  const stream = await sendMessageStream(conversation.id, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "What do you see in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: imageData,
          },
        },
      ],
    },
  ]);

  console.log("\nAgent response:");
  let fullResponse = "";
  for await (const chunk of stream) {
    if (chunk.message_type === "assistant_message" && chunk.content) {
      let contentText = "";
      if (typeof chunk.content === "string") {
        contentText = chunk.content;
      } else if (Array.isArray(chunk.content)) {
        contentText = chunk.content
          .filter((item) => item.type === "text")
          .map((item) => ("text" in item ? item.text : ""))
          .join("");
      }
      fullResponse += contentText;
      process.stdout.write(contentText);
    }
  }
  if (!fullResponse) {
    console.log("(no assistant message received)");
  }
  console.log("\n\n✅ Done!");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
