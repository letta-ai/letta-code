import { describe, expect, test } from "bun:test";
import {
  downloadFileFromSandbox,
  ensureConversationSandbox,
  type SandboxFilesApiDeps,
  uploadFileToSandbox,
} from "@/backend/api/sandbox-files";

function createDeps(
  response: Response,
  calls: Array<{ input: string; init?: RequestInit }>,
): SandboxFilesApiDeps {
  return {
    getConfig: async () => ({
      baseUrl: "https://api.letta.test",
      apiKey: "secret",
    }),
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return response;
    },
  };
}

describe("sandbox file API", () => {
  test("ensures the conversation-scoped sandbox", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const result = await ensureConversationSandbox(
      "agent-1",
      "conv-1",
      createDeps(
        Response.json({
          sandboxId: "sandbox-1",
          deviceId: "device-1",
          connectionName: "Cloud",
          conversationId: "conv-1",
          resumed: true,
        }),
        calls,
      ),
    );

    expect(result.sandboxId).toBe("sandbox-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      "https://api.letta.test/v1/agents/agent-1/sandboxes",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ conversationId: "conv-1" }),
    );
  });

  test("uploads multipart data without a JSON content type", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const result = await uploadFileToSandbox(
      "sandbox-1",
      { blob: new Blob(["hello"]), name: "note.txt" },
      createDeps(
        Response.json({
          files: [
            {
              path: "/root/downloads/upload/note.txt",
              name: "note.txt",
              mimeType: "text/plain",
              size: 5,
            },
          ],
        }),
        calls,
      ),
    );

    expect(result.files[0]?.path).toBe("/root/downloads/upload/note.txt");
    const request = calls[0]?.init;
    expect(request?.body).toBeInstanceOf(FormData);
    expect(new Headers(request?.headers).has("Content-Type")).toBe(false);
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      "Bearer secret",
    );
  });

  test("downloads binary file contents", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const result = await downloadFileFromSandbox(
      "sandbox-1",
      "/root/downloads/report.txt",
      createDeps(new Response(new Uint8Array([1, 2, 3])), calls),
    );

    expect([...result]).toEqual([1, 2, 3]);
    expect(calls[0]?.input).toBe(
      "https://api.letta.test/v1/sandboxes/sandbox-1/files?path=%2Froot%2Fdownloads%2Freport.txt",
    );
  });
});
