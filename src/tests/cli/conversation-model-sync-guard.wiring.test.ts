import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("conversation model sync guard wiring", () => {
  test("App.tsx tracks recent conversation overrides and guards local fallback", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("recentConversationModelOverrideRef");
    expect(source).toContain("markRecentConversationModelOverride");
    expect(source).toContain("hasFreshConversationModelOverride");
    expect(source).toContain(
      "Skipping local agent model apply due to fresh conversation override",
    );
  });

  test("sync effect uses generation guard to prevent stale commits", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("const modelSyncGenerationRef = useRef(0);");
    expect(source).toContain(
      "const syncGeneration = ++modelSyncGenerationRef.current;",
    );
    expect(source).toContain(
      "const isStaleSync = () =>\n      cancelled || syncGeneration !== modelSyncGenerationRef.current;",
    );
    expect(source).toContain("if (isStaleSync()) return;");
  });

  test("sync effect does not apply agent defaults when a recent local override exists", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const effectStart = source.indexOf(
      "// Keep effective model state in sync with the active conversation override.",
    );
    const effectEnd = source.indexOf(
      "// Helper to append an error to the transcript",
      effectStart,
    );
    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const segment = source.slice(effectStart, effectEnd);

    expect(segment).toContain(
      "if (hasFreshConversationModelOverride(conversationId))",
    );
    expect(segment).toContain(
      "Skipping local agent model apply due to fresh conversation override",
    );
  });

  test("/model and reasoning flush mark recent conversation overrides", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const modelHandlerStart = source.indexOf(
      "const handleModelSelect = useCallback(",
    );
    const modelHandlerEnd = source.indexOf(
      "const handleSystemPromptSelect = useCallback(",
      modelHandlerStart,
    );
    expect(modelHandlerStart).toBeGreaterThanOrEqual(0);
    expect(modelHandlerEnd).toBeGreaterThan(modelHandlerStart);
    const modelHandlerSegment = source.slice(
      modelHandlerStart,
      modelHandlerEnd,
    );
    expect(modelHandlerSegment).toContain(
      "markRecentConversationModelOverride(targetConversationId)",
    );

    const reasoningStart = source.indexOf(
      "const flushPendingReasoningEffort = useCallback(async () => {",
    );
    const reasoningEnd = source.indexOf(
      "const handleCycleReasoningEffort = useCallback(() => {",
      reasoningStart,
    );
    expect(reasoningStart).toBeGreaterThanOrEqual(0);
    expect(reasoningEnd).toBeGreaterThan(reasoningStart);
    const reasoningSegment = source.slice(reasoningStart, reasoningEnd);
    expect(reasoningSegment).toContain(
      "markRecentConversationModelOverride(targetConversationId)",
    );
  });
});
