import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

describe("headless backend lifecycle wiring", () => {
  test("headless startup and approval recovery route lifecycle SDK calls through Backend", () => {
    const source = readSource("../../headless.ts");

    expect(source).toContain("const backend = getBackend();");
    const backendReadyIndex = source.indexOf("const backend = getBackend();");
    const agentLookupIndex = source.indexOf("// Priority 0: --conversation");
    expect(backendReadyIndex).toBeGreaterThan(-1);
    expect(agentLookupIndex).toBeGreaterThan(backendReadyIndex);
    expect(source.slice(backendReadyIndex, agentLookupIndex)).not.toContain(
      "getClient()",
    );

    expect(source).toContain("backend.retrieveAgent(");
    expect(source).toContain("backend.retrieveConversation(");
    expect(source).toContain("backend.createConversation(");
    expect(source).toContain("backend.updateAgent(");

    expect(source).not.toContain("client.agents.");
    expect(source).not.toContain("client.conversations.");
    expect(source).not.toContain("client.messages.");
  });

  test("resume data probes use Backend instead of raw SDK clients", () => {
    const source = readSource("../../agent/check-approval.ts");

    expect(source).toContain("getBackend().retrieveConversation");
    expect(source).toContain("getBackend().listConversationMessages");
    expect(source).toContain("getBackend().listAgentMessages");
    expect(source).toContain("getBackend().retrieveMessage");

    expect(source).not.toContain("client.conversations.");
    expect(source).not.toContain("client.agents.");
    expect(source).not.toContain("client.messages.");
  });
});
