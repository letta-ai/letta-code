import { describe, expect, test } from "bun:test";
import {
  formatChannelControlRequestPrompt,
  parseChannelControlRequestResponse,
} from "../../channels/interactive";
import type { ChannelControlRequestEvent } from "../../channels/types";

function createEvent(
  overrides: Partial<ChannelControlRequestEvent> = {},
): ChannelControlRequestEvent {
  return {
    requestId: "req-1",
    kind: "ask_user_question",
    source: {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which approach should we use?",
          header: "Approach",
          options: [
            {
              label: "Fast path",
              description: "Ship the smallest safe patch",
            },
            {
              label: "Deep refactor",
              description: "Restructure the code more thoroughly",
            },
          ],
          multiSelect: false,
        },
      ],
    },
    ...overrides,
  };
}

describe("channel interactive prompts", () => {
  test("formats AskUserQuestion prompts with options and reply instructions", () => {
    const prompt = formatChannelControlRequestPrompt(createEvent());

    expect(prompt).toContain(
      "The agent needs an answer before it can continue.",
    );
    expect(prompt).toContain("1. Which approach should we use?");
    expect(prompt).toContain("1) Fast path");
    expect(prompt).toContain("2) Deep refactor");
    expect(prompt).toContain("Reply with an option number/label");
  });

  test("formats multi-select questions with comma-separated reply guidance", () => {
    const prompt = formatChannelControlRequestPrompt(
      createEvent({
        input: {
          questions: [
            {
              question: "Which features should we enable?",
              header: "Features",
              options: [
                {
                  label: "Search",
                  description: "Enable full-text search",
                },
                {
                  label: "Sync",
                  description: "Enable background syncing",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
    );

    expect(prompt).toContain(
      "Choose one or more options. Separate multiple answers with commas.",
    );
    expect(prompt).toContain(
      "Reply with one or more option numbers/labels separated by commas",
    );
  });

  test("maps single-question numeric replies onto the selected label", () => {
    const parsed = parseChannelControlRequestResponse(createEvent(), "2");

    expect(parsed).toEqual({
      type: "response",
      response: {
        request_id: "req-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which approach should we use?",
                header: "Approach",
                options: [
                  {
                    label: "Fast path",
                    description: "Ship the smallest safe patch",
                  },
                  {
                    label: "Deep refactor",
                    description: "Restructure the code more thoroughly",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which approach should we use?": "Deep refactor",
            },
          },
        },
      },
    });
  });

  test("maps single-question multi-select replies onto normalized labels", () => {
    const parsed = parseChannelControlRequestResponse(
      createEvent({
        input: {
          questions: [
            {
              question: "Which features should we enable?",
              header: "Features",
              options: [
                {
                  label: "Search",
                  description: "Enable full-text search",
                },
                {
                  label: "Sync",
                  description: "Enable background syncing",
                },
                {
                  label: "Alerts",
                  description: "Enable alert notifications",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      "1, 3",
    );

    expect(parsed).toEqual({
      type: "response",
      response: {
        request_id: "req-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which features should we enable?",
                header: "Features",
                options: [
                  {
                    label: "Search",
                    description: "Enable full-text search",
                  },
                  {
                    label: "Sync",
                    description: "Enable background syncing",
                  },
                  {
                    label: "Alerts",
                    description: "Enable alert notifications",
                  },
                ],
                multiSelect: true,
              },
            ],
            answers: {
              "Which features should we enable?": "Search, Alerts",
            },
          },
        },
      },
    });
  });

  test("requires numbered lines for multi-question replies", () => {
    const parsed = parseChannelControlRequestResponse(
      createEvent({
        input: {
          questions: [
            {
              question: "Which approach should we use?",
              header: "Approach",
              options: [
                {
                  label: "Fast path",
                  description: "Ship the smallest safe patch",
                },
                {
                  label: "Deep refactor",
                  description: "Restructure the code more thoroughly",
                },
              ],
              multiSelect: false,
            },
            {
              question: "Which environment should we test in?",
              header: "Env",
              options: [
                {
                  label: "Staging",
                  description: "Safer rollout path",
                },
                {
                  label: "Production",
                  description: "Use the live environment directly",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      "deep refactor please",
    );

    expect(parsed).toEqual({
      type: "reprompt",
      message:
        "Please answer with numbered lines so I can map each reply to the right question.\nExample:\n1: your answer\n2: your answer",
    });
  });

  test("parses numbered multi-question replies into updated_input.answers", () => {
    const parsed = parseChannelControlRequestResponse(
      createEvent({
        input: {
          questions: [
            {
              question: "Which approach should we use?",
              header: "Approach",
              options: [
                {
                  label: "Fast path",
                  description: "Ship the smallest safe patch",
                },
                {
                  label: "Deep refactor",
                  description: "Restructure the code more thoroughly",
                },
              ],
              multiSelect: false,
            },
            {
              question: "Which environment should we test in?",
              header: "Env",
              options: [
                {
                  label: "Staging",
                  description: "Safer rollout path",
                },
                {
                  label: "Production",
                  description: "Use the live environment directly",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      "1: 2\n2: staging",
    );

    expect(parsed).toEqual({
      type: "response",
      response: {
        request_id: "req-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which approach should we use?",
                header: "Approach",
                options: [
                  {
                    label: "Fast path",
                    description: "Ship the smallest safe patch",
                  },
                  {
                    label: "Deep refactor",
                    description: "Restructure the code more thoroughly",
                  },
                ],
                multiSelect: false,
              },
              {
                question: "Which environment should we test in?",
                header: "Env",
                options: [
                  {
                    label: "Staging",
                    description: "Safer rollout path",
                  },
                  {
                    label: "Production",
                    description: "Use the live environment directly",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which approach should we use?": "Deep refactor",
              "Which environment should we test in?": "Staging",
            },
          },
        },
      },
    });
  });

  test("parses numbered multi-question replies with multi-select answers", () => {
    const parsed = parseChannelControlRequestResponse(
      createEvent({
        input: {
          questions: [
            {
              question: "Which features should we enable?",
              header: "Features",
              options: [
                {
                  label: "Search",
                  description: "Enable full-text search",
                },
                {
                  label: "Sync",
                  description: "Enable background syncing",
                },
                {
                  label: "Alerts",
                  description: "Enable alert notifications",
                },
              ],
              multiSelect: true,
            },
            {
              question: "Which environment should we test in?",
              header: "Env",
              options: [
                {
                  label: "Staging",
                  description: "Safer rollout path",
                },
                {
                  label: "Production",
                  description: "Use the live environment directly",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      "1: 1, 2\n2: staging",
    );

    expect(parsed).toEqual({
      type: "response",
      response: {
        request_id: "req-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which features should we enable?",
                header: "Features",
                options: [
                  {
                    label: "Search",
                    description: "Enable full-text search",
                  },
                  {
                    label: "Sync",
                    description: "Enable background syncing",
                  },
                  {
                    label: "Alerts",
                    description: "Enable alert notifications",
                  },
                ],
                multiSelect: true,
              },
              {
                question: "Which environment should we test in?",
                header: "Env",
                options: [
                  {
                    label: "Staging",
                    description: "Safer rollout path",
                  },
                  {
                    label: "Production",
                    description: "Use the live environment directly",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which features should we enable?": "Search, Sync",
              "Which environment should we test in?": "Staging",
            },
          },
        },
      },
    });
  });

  test("truncates long ExitPlanMode plan previews for channel delivery", () => {
    const prompt = formatChannelControlRequestPrompt(
      createEvent({
        kind: "exit_plan_mode",
        toolName: "ExitPlanMode",
        input: {},
        planFilePath: "/tmp/plan.md",
        planContent: `${"Plan line\n".repeat(300)}Conclusion`,
      }),
    );

    expect(prompt).toContain("Proposed plan:");
    expect(prompt).toContain("[Plan preview truncated for channel delivery.]");
    expect(prompt).toContain("Plan file: /tmp/plan.md");
  });

  test("turns ExitPlanMode feedback into a deny response", () => {
    const parsed = parseChannelControlRequestResponse(
      createEvent({
        kind: "exit_plan_mode",
        toolName: "ExitPlanMode",
        input: {},
      }),
      "keep planning: please tighten the rollback story",
    );

    expect(parsed).toEqual({
      type: "response",
      response: {
        request_id: "req-1",
        decision: {
          behavior: "deny",
          message: "keep planning: please tighten the rollback story",
        },
      },
    });
  });

  test("treats generic tool approval feedback as a denial message", () => {
    const parsed = parseChannelControlRequestResponse(
      createEvent({
        kind: "generic_tool_approval",
        toolName: "Bash",
        input: { command: "rm -rf /tmp/bench" },
      }),
      "deny - don't touch that directory",
    );

    expect(parsed).toEqual({
      type: "response",
      response: {
        request_id: "req-1",
        decision: {
          behavior: "deny",
          message: "don't touch that directory",
        },
      },
    });
  });
});
