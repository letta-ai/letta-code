import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

describe("listener tool prep metadata reuse", () => {
  test("tool prep accepts cached agent and effective model inputs", () => {
    const source = readSource("../../tools/toolset.ts");

    expect(source).toContain("cachedAgent?: AgentState | null;");
    expect(source).toContain("cachedEffectiveModel?: string | null;");
    expect(source).toContain("cachedAgent ??");
    expect(source).toContain("resolveModel(cachedEffectiveModel)");
  });

  test("listener turn passes cached agent metadata into reflection and tool prep", () => {
    const source = readSource("../../websocket/listener/turn.ts");

    expect(source).toContain("cachedAgent: AgentState | null = null;");
    expect(source).toContain("cachedAgent = (await client.agents.retrieve");
    expect(source).toContain("buildMaybeLaunchReflectionSubagent({");
    expect(source).toContain("cachedAgent,");
    expect(source).toContain("prepareToolExecutionContextForScope({");
  });
});
