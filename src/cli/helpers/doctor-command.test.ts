import { expect, test } from "bun:test";
import { buildDoctorMessage } from "./doctor-command";

test.each([false, true])(
  "starts a primary investigation with the incident reference intact (local=%s)",
  (local) => {
    const prompt = buildDoctorMessage({
      agentId: "agent-current",
      conversationId: "conv-investigation",
      local,
      symptom: "Inspect conv-incident for the lunch thread leak",
    });
    expect(prompt).toContain('skill: "context-doctor"');
    expect(prompt).toContain("primary investigator");
    expect(prompt).toContain("Current agent ID: agent-current");
    expect(prompt).toContain(
      "Investigation conversation ID: conv-investigation",
    );
    expect(prompt).toContain(`Backend: ${local ? "local" : "api"}`);
    expect(prompt).toContain(
      "User symptom: Inspect conv-incident for the lunch thread leak",
    );
    expect(prompt).toContain("not automatically the target conversation");
    expect(prompt).not.toContain("Target conversation ID: conv-investigation");
    expect(prompt).not.toContain("worktree");
  },
);

test("a fresh conversation needs no existing transcript or memory to start doctor", () => {
  const prompt = buildDoctorMessage({
    agentId: "agent-current",
    conversationId: null,
    local: true,
  });
  expect(prompt).toContain("Investigation conversation ID: (new conversation)");
  expect(prompt).toContain("Current agent memory format: none");
  expect(prompt).toContain("recent history across conversations");
});
