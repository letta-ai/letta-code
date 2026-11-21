import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const storageDir = mkdtempSync(join(tmpdir(), "local-store-prompts-"));
  directories.push(storageDir);
  const writer = new LocalStore("agent-default", { storageDir });
  const agent = writer.createAgent({ name: "PromptAgent" });
  function seed(content: string) {
    const { id } = writer.createConversation({ agent_id: agent.id });
    writer.setCompiledSystemPrompt(id, agent.id, {
      content,
      compiledAt: new Date().toISOString(),
      coreMemory: "",
      rawSystemHash: "original",
    });
    return id;
  }
  const ids = [seed("one"), seed("two")] as const;
  const reader = new LocalStore("agent-default", { storageDir });
  return { reader, writer, ids, agent };
}

test("a storage scan leaves compiled prompts unloaded until requested", () => {
  const { reader, ids, agent } = fixture();
  const listed = reader.listConversations({ agent_id: agent.id });
  expect(listed.map(({ id }) => id)).toEqual(expect.arrayContaining([...ids]));
  const cache = reader["compiledSystemPromptByConversationKey"];
  expect(cache.size).toBe(0);
  expect(reader.getCompiledSystemPrompt(ids[1], agent.id)?.content).toBe("two");
  expect(cache.size).toBe(1);
});

test("refresh observes an external prompt replacement and deletion", () => {
  const { reader, writer, ids, agent } = fixture();
  const id = ids[0];
  const original = reader.getCompiledSystemPrompt(id, agent.id);
  if (!original) throw new Error("Missing initial prompt");
  const replacement = { ...original, content: "replacement" };
  writer.setCompiledSystemPrompt(id, agent.id, replacement);
  writer.updateConversation(id, { summary: "updated" });
  expect(reader.getCompiledSystemPrompt(id, agent.id)).toEqual(replacement);
  writer.clearCompiledSystemPromptsForAgent(agent.id);
  writer.updateConversation(id, { summary: "cleared" });
  expect(reader.getCompiledSystemPrompt(id, agent.id)).toBeUndefined();
});
