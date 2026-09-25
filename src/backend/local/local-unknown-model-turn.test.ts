import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "./local-backend";

/**
 * LET-13253: a conversation configured with a model the bundled runtime does
 * not know must fail the turn with an actionable error — never silently eat
 * it. Desktop and CLI release cadences differ, so a model configured on a
 * newer surface can be unknown to an older bundled runtime.
 *
 * Drives the real LocalBackend and real pi-ai model resolution (no executor
 * stub): resolution fails before any provider request, so no credentials or
 * network are needed.
 */
describe("local turn with an unknown model", () => {
  test("fails the run with an actionable error message on every turn", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "unknown-model-turn-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Unknown model target",
        model: "anthropic/claude-opus-9-9",
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      // Two sequential turns, matching the reported pair of eaten messages.
      for (const text of ["first message", "second message"]) {
        const result = (await backend.streamConversationMessages(
          conversation.id,
          {
            messages: [{ type: "message", role: "user", content: text }],
          } as never,
        )) as { stream?: AsyncIterable<Record<string, unknown>> };
        const stream = (result.stream ?? result) as AsyncIterable<
          Record<string, unknown>
        >;
        const chunks: Array<Record<string, unknown>> = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const errorChunk = chunks.find(
          (chunk) => chunk.message_type === "error_message",
        );
        expect(errorChunk?.message).toBe(
          'Unknown model "claude-opus-9-9" for provider "anthropic". ' +
            "Choose an available model with /model.",
        );
        expect(chunks.map((chunk) => chunk.stop_reason)).toContain("error");

        const runId = chunks.find((chunk) => chunk.run_id)?.run_id;
        expect(typeof runId).toBe("string");
        const run = (await backend.retrieveRun(runId as string)) as {
          status?: string;
          metadata?: Record<string, unknown>;
        };
        expect(run.status).toBe("failed");
        const runError = run.metadata?.error as
          | Record<string, unknown>
          | undefined;
        expect(runError?.message).toBe(errorChunk?.message);
        expect(runError?.retryable).toBe(false);
      }
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  }, 30_000);
});
