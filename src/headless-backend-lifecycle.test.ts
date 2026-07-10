import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readInteractiveAppSource } from "@/test-utils/read-interactive-app-source";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

function expectManagedPromptUpdatesViaBackend(source: string): void {
  const systemPromptVersioningSource = readSource(
    "./agent/system-prompt-versioning.ts",
  );

  expect(source).toContain("scheduleManagedSystemPromptUpdate(");
  expect(systemPromptVersioningSource).toMatch(
    /getBackend\(\)\s*\.\s*updateAgent\(/,
  );
  expect(systemPromptVersioningSource).not.toContain("client.agents.");
}

describe("headless backend lifecycle wiring", () => {
  test("headless startup and approval recovery route lifecycle SDK calls through Backend", () => {
    const source = readSource("./headless.ts");

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
    expectManagedPromptUpdatesViaBackend(source);

    expect(source).not.toContain("client.agents.");
    expect(source).not.toContain("client.conversations.");
    expect(source).not.toContain("client.messages.");
  });

  test("resume data probes use Backend instead of raw SDK clients", () => {
    const source = readSource("./agent/check-approval.ts");

    expect(source).toContain("getBackend().retrieveConversation");
    expect(source).toContain("getBackend().getConversationResumeTail");
    expect(source).toContain("getBackend().retrieveMessage");

    expect(source).not.toContain("client.conversations.");
    expect(source).not.toContain("client.agents.");
    expect(source).not.toContain("client.messages.");
  });

  test("interactive startup routes lifecycle SDK calls through Backend", () => {
    const source = readSource("./index.ts");

    expect(source).toContain("const backend = getBackend();");
    expect(source).toContain("backend.retrieveAgent(");
    expect(source).toContain("backend.retrieveConversation(");
    expect(source).toContain("backend.createConversation(");
    expectManagedPromptUpdatesViaBackend(source);
    expect(source).toContain("getResumeDataFromBackend(");

    expect(source).not.toContain("getClient");
    expect(source).not.toContain("client.agents.");
    expect(source).not.toContain("client.conversations.");
    expect(source).not.toContain("client.messages.");
  });

  test("interactive profile picker resolves agents through Backend", () => {
    const source = readSource("./cli/profile-selection.tsx");

    expect(source).toContain('import { getBackendForMode } from "@/backend"');
    expect(source).toContain("backend.retrieveAgent(");
    expect(source).not.toContain("getClient");
    expect(source).not.toContain("client.agents.");
  });

  test("interactive ready-state agent config refresh uses Backend", () => {
    const source = readInteractiveAppSource();

    const start = source.indexOf("// Fetch llmConfig when agent is ready");
    const end = source.indexOf("// Update project settings", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const section = source.slice(start, end);
    expect(section).toContain("backend.retrieveAgent(agentId)");
    const capabilityGuardIndex = section.indexOf(
      "backend.capabilities.serverSideToolManagement",
    );
    const getClientIndex = section.indexOf("getClient()");
    expect(capabilityGuardIndex).toBeGreaterThan(-1);
    expect(getClientIndex).toBeGreaterThan(capabilityGuardIndex);
    expect(section.slice(0, capabilityGuardIndex)).not.toContain("getClient");
    expect(section.slice(0, capabilityGuardIndex)).not.toContain(
      "client.agents.",
    );
  });

  test("memfs flag application skips remote operations for local backends", () => {
    const source = readSource("./agent/memory-filesystem.ts");

    const capabilityGuardIndex = source.indexOf(
      "!backend.capabilities.remoteMemfs",
    );
    const promptUpdateIndex = source.indexOf("updateAgentSystemPromptMemfs");
    const tagAddIndex = source.indexOf("addGitMemoryTag");

    expect(capabilityGuardIndex).toBeGreaterThan(-1);
    expect(promptUpdateIndex).toBeGreaterThan(capabilityGuardIndex);
    expect(tagAddIndex).toBeGreaterThan(capabilityGuardIndex);
  });
});
