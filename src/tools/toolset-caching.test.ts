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
    const source = readSource("./toolset.ts");

    expect(source).toContain("cachedAgent?: AgentState | null;");
    expect(source).toContain("cachedEffectiveModel?: string | null;");
    expect(source).toContain("cachedAgent ??");
    expect(source).toContain("resolveModel(cachedEffectiveModel)");
  });

  test("listener turn passes cached agent metadata into reflection and tool prep", () => {
    const listenSource = readSource("../cli/subcommands/listen.tsx");
    const turnSource = readSource("../websocket/listener/turn.ts");
    const setupSource = readSource("../websocket/listener/turn-setup.ts");
    const completionSource = readSource(
      "../websocket/listener/turn-completion.ts",
    );

    expect(setupSource).toContain("cachedAgent: AgentState | null = null;");
    expect(setupSource).toContain(
      "cachedAgent = (await getBackend().retrieveAgent(",
    );
    expect(listenSource).toContain('skills: { type: "string" }');
    expect(listenSource).toContain("process.env.LETTA_SKILLS_DIRECTORY");
    expect(listenSource.match(/skillsDirectory,/g)).toHaveLength(2);
    expect(setupSource).toContain("prepareToolExecutionContextForScope({");
    expect(setupSource).toContain(
      "skillsDirectory: listenerOptions?.skillsDirectory,",
    );
    expect(readSource("./toolset.ts")).toContain("{ skillsDirectory }");
    expect(turnSource).toContain("getCachedAgent: setup.getCachedAgent,");
    expect(completionSource).toContain("buildMaybeLaunchReflectionSubagent({");
    expect(completionSource).toContain("cachedAgent: params.getCachedAgent(),");
  });
});
