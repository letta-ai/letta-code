import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  prependReminderPartsToContent,
  type ReminderTextPart,
} from "@/reminders/engine";
import { getListenerReminderTarget } from "./turn-reminders";

const reminders: ReminderTextPart[] = [
  {
    type: "text",
    text: "<system-reminder>Environment context</system-reminder>",
  },
  { type: "text", text: "<system-reminder>Agent info</system-reminder>" },
];

const approval: ApprovalCreate = { type: "approval", approvals: [] };

describe("listener reminder target", () => {
  test("system-only onboarding trigger carries context without a fake user", () => {
    const trigger: MessageCreate = {
      role: "system",
      content: "Begin onboarding in Main chat.",
      otid: "onboarding-trigger",
    };
    const messages = [trigger];
    const target = getListenerReminderTarget(messages);
    expect(target).toBe(trigger);
    if (!target) throw new Error("Missing reminder target");
    target.content = prependReminderPartsToContent(target.content, reminders);
    expect(messages).toEqual([
      {
        role: "system",
        otid: "onboarding-trigger",
        content: [
          ...reminders,
          { type: "text", text: "Begin onboarding in Main chat." },
        ],
      },
    ]);
  });

  test("prefers first user even when system messages precede it", () => {
    const system: MessageCreate = { role: "system", content: "System trigger" };
    const user: MessageCreate = { role: "user", content: "First user" };
    const laterUser: MessageCreate = { role: "user", content: "Later user" };
    expect(getListenerReminderTarget([system, user, laterUser])).toBe(user);
    expect(system.content).toBe("System trigger");
    expect(laterUser.content).toBe("Later user");
  });

  test("selects only first system message and preserves structured content", () => {
    const content: MessageCreate["content"] = [
      { type: "text", text: "Start onboarding" },
    ];
    const first: MessageCreate = { role: "system", content };
    const second: MessageCreate = { role: "system", content: "Follow-up" };
    const target = getListenerReminderTarget([first, second]);
    expect(target).toBe(first);
    if (!target) throw new Error("Missing reminder target");
    target.content = prependReminderPartsToContent(target.content, reminders);
    expect(target.content).toEqual([...reminders, ...content]);
    expect(content).toEqual([{ type: "text", text: "Start onboarding" }]);
    expect(second.content).toBe("Follow-up");
  });

  test("queued interrupt approvals cannot become the reminder carrier", () => {
    const system: MessageCreate = { role: "system", content: "Continue" };
    const user: MessageCreate = { role: "user", content: "Continue" };
    expect(getListenerReminderTarget([approval, system])).toBe(system);
    expect(getListenerReminderTarget([approval, system, user])).toBe(user);
    expect(approval).toEqual({ type: "approval", approvals: [] });
  });

  test("no carrier for approval-only, empty, or assistant-only input", () => {
    expect(getListenerReminderTarget([approval])).toBeUndefined();
    expect(getListenerReminderTarget([])).toBeUndefined();
    expect(
      getListenerReminderTarget([
        { role: "assistant", content: "Prior answer" },
      ]),
    ).toBeUndefined();
  });

  test("empty reminders preserve the original system content", () => {
    const system: MessageCreate = { role: "system", content: "Continue" };
    const target = getListenerReminderTarget([system]);
    if (!target) throw new Error("Missing reminder target");
    expect(prependReminderPartsToContent(target.content, [])).toBe("Continue");
  });
});
