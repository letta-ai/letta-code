import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("footer reasoning regression", () => {
  test("right-side model/reasoning label is not blanked when footer is hidden", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // The InputFooter right-side column must NOT use hideFooterContent to
    // replace the label with spaces. The left side may still be hidden.
    // Previously the right-side had:
    //   {hideFooterContent ? (<Text>{" ".repeat(...)}</Text>) : ...}
    // which blanked the model/reasoning tag during streaming.
    const rightColumnStart = source.indexOf(
      "flexShrink={0}\n      >\n",
      source.indexOf("const InputFooter = memo("),
    );
    expect(rightColumnStart).toBeGreaterThanOrEqual(0);

    // The first rendering branch after the right-column Box must NOT be
    // a hideFooterContent ternary that emits blank spaces.
    const rightColumnWindow = source.slice(
      rightColumnStart,
      rightColumnStart + 200,
    );
    expect(rightColumnWindow).not.toMatch(
      /hideFooterContent\s*\?\s*\(\s*<Text>\{" "\.repeat/,
    );

    // Confirm the left side still respects hideFooterContent.
    const leftSideContent = source.slice(
      source.indexOf("<Box flexGrow={1} paddingRight={1}>"),
      source.indexOf(
        "</Box>",
        source.indexOf("<Box flexGrow={1} paddingRight={1}>"),
      ),
    );
    expect(leftSideContent).toContain("hideFooterContent");
  });

  test("hideFooterContent only suppresses left-side footer content", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // hideFooterContent must only appear in the left-side column, never in
    // the right-side column (which renders the model/reasoning label).
    const footerFn = source.slice(source.indexOf("const InputFooter = memo("));
    const leftColumn = footerFn.slice(
      footerFn.indexOf("<Box flexGrow={1}"),
      footerFn.indexOf("</Box>", footerFn.indexOf("<Box flexGrow={1}")),
    );
    expect(leftColumn).toContain("hideFooterContent");

    // Right column should NOT reference hideFooterContent at all.
    const rightColumnStart = footerFn.indexOf("flexShrink={0}");
    const rightColumnEnd = footerFn.indexOf(
      "</Box>",
      footerFn.indexOf("</Box>", rightColumnStart) + 1,
    );
    const rightColumn = footerFn.slice(rightColumnStart, rightColumnEnd);
    expect(rightColumn).not.toContain("hideFooterContent");
  });

  test("deriveReasoningEffort handles chatgpt_oauth provider", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const fnStart = source.indexOf("function deriveReasoningEffort(");
    const fnEnd = source.indexOf("\n}\n", fnStart);
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = source.slice(fnStart, fnEnd);

    // Must explicitly handle chatgpt_oauth alongside openai.
    expect(fnBody).toContain('modelSettings.provider_type === "chatgpt_oauth"');
    // Both should use reasoning.reasoning_effort shape.
    expect(fnBody).toContain('modelSettings.provider_type === "openai"');
  });

  test("syncAgentState uses deriveReasoningEffort for comparison", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const syncStart = source.indexOf("const syncAgentState = async ()");
    const syncEnd = source.indexOf("void syncAgentState();", syncStart);
    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = source.slice(syncStart, syncEnd);

    // Reasoning comparison must use deriveReasoningEffort, not raw
    // llm_config.reasoning_effort, to correctly handle chatgpt_oauth and
    // other providers where model_settings is the source of truth.
    const deriveCallCount = (syncBody.match(/deriveReasoningEffort\(/g) ?? [])
      .length;
    expect(deriveCallCount).toBeGreaterThanOrEqual(2);

    // Must NOT directly compare llm_config.reasoning_effort for the
    // current vs agent staleness check.
    expect(syncBody).not.toContain(
      "const currentEffort = llmConfigRef.current?.reasoning_effort",
    );
    expect(syncBody).not.toContain(
      "const agentEffort = agent.llm_config.reasoning_effort",
    );
  });

  test("initial config fetch uses deriveReasoningEffort for model info", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    // Find the fetchConfig block that runs on loadingState === "ready"
    const fetchConfigStart = source.indexOf("const fetchConfig = async ()");
    const fetchConfigEnd = source.indexOf("fetchConfig();", fetchConfigStart);
    expect(fetchConfigStart).toBeGreaterThanOrEqual(0);
    expect(fetchConfigEnd).toBeGreaterThan(fetchConfigStart);
    const fetchConfigBody = source.slice(fetchConfigStart, fetchConfigEnd);

    // Should derive effective reasoning from model_settings, not just
    // pass raw llm_config to getModelInfoForLlmConfig.
    expect(fetchConfigBody).toContain("deriveReasoningEffort(");
    expect(fetchConfigBody).toContain("effectiveReasoningEffort");
  });
});
