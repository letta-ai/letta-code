import { describe, expect, test } from "bun:test";
import {
  buildConversationMessagesCreateRequestBody,
  selectClientSkillsForRequest,
} from "../../agent/message";

describe("buildConversationMessagesCreateRequestBody client_skills", () => {
  test("includes client_skills alongside client_tools", () => {
    const body = buildConversationMessagesCreateRequestBody(
      "default",
      [{ type: "message", role: "user", content: "hello" }],
      { agentId: "agent-1", streamTokens: true, background: true },
      [
        {
          name: "ShellCommand",
          description: "Run shell command",
          parameters: { type: "object", properties: {} },
        },
      ],
      [
        {
          name: "debugging",
          description: "Debugging checklist",
          location: "/tmp/.skills/debugging/SKILL.md",
        },
      ],
    );

    expect(body.client_tools).toHaveLength(1);
    expect(body.client_skills).toEqual([
      {
        name: "debugging",
        description: "Debugging checklist",
        location: "/tmp/.skills/debugging/SKILL.md",
      },
    ]);
  });
});

describe("selectClientSkillsForRequest", () => {
  test("suppresses unchanged client_skills for the same conversation", () => {
    const previousFingerprints = new Map<string, string>();
    const clientSkills = [
      {
        name: "debugging",
        description: "Debugging checklist",
        location: "/tmp/.skills/debugging/SKILL.md",
      },
    ];

    const firstSelection = selectClientSkillsForRequest(
      "default",
      "agent-1",
      clientSkills,
      previousFingerprints,
    );

    expect(firstSelection.clientSkillsForRequest).toEqual(clientSkills);
    expect(firstSelection.fingerprintToPersist).not.toBeNull();

    if (firstSelection.fingerprintToPersist === null) {
      throw new Error("expected first selection fingerprint");
    }
    previousFingerprints.set(
      firstSelection.stateKey,
      firstSelection.fingerprintToPersist,
    );

    const secondSelection = selectClientSkillsForRequest(
      "default",
      "agent-1",
      clientSkills,
      previousFingerprints,
    );

    expect(secondSelection.clientSkillsForRequest).toEqual([]);
    expect(secondSelection.fingerprintToPersist).toBeNull();
  });

  test("re-sends client_skills when the payload changes", () => {
    const previousFingerprints = new Map<string, string>();
    const initialSkills = [
      {
        name: "debugging",
        description: "Debugging checklist",
        location: "/tmp/.skills/debugging/SKILL.md",
      },
    ];

    const changedSkills = [
      ...initialSkills,
      {
        name: "review-pr",
        description: "Review pull requests",
        location: "/tmp/.skills/review-pr/SKILL.md",
      },
    ];

    const initialSelection = selectClientSkillsForRequest(
      "default",
      "agent-1",
      initialSkills,
      previousFingerprints,
    );

    expect(initialSelection.fingerprintToPersist).not.toBeNull();
    if (initialSelection.fingerprintToPersist === null) {
      throw new Error("expected initial selection fingerprint");
    }
    previousFingerprints.set(
      initialSelection.stateKey,
      initialSelection.fingerprintToPersist,
    );

    const changedSelection = selectClientSkillsForRequest(
      "default",
      "agent-1",
      changedSkills,
      previousFingerprints,
    );

    expect(changedSelection.clientSkillsForRequest).toEqual(changedSkills);
    expect(changedSelection.fingerprintToPersist).not.toBeNull();
  });
});
