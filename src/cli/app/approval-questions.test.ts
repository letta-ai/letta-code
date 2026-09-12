import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { getQuestionsFromApproval } from "./approval-questions";

const approval = (toolArgs: string): ApprovalRequest => ({
  toolCallId: "tc-1",
  toolName: "AskUserQuestion",
  toolArgs,
});

describe("getQuestionsFromApproval (shared validator)", () => {
  // This parser shares parseAskUserQuestions with ApprovalSwitch.getQuestions,
  // so it must reject the same malformed shapes that would brick the TUI via
  // the render path. These cases pin the submit-side path against regressions.

  test("returns parsed questions for a well-formed payload", () => {
    const args = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [
            { label: "A", description: "d" },
            { label: "B", description: "d" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(getQuestionsFromApproval(approval(args))).toHaveLength(1);
  });

  test("returns [] when `questions` is a JSON string (regression)", () => {
    const malformed = JSON.stringify({
      questions: JSON.stringify([
        {
          header: "H",
          question: "Q?",
          options: [{ label: "A", description: "" }],
          multiSelect: false,
        },
      ]),
    });
    expect(getQuestionsFromApproval(approval(malformed))).toEqual([]);
  });

  test("returns [] for non-string question/header/description", () => {
    const baseOptions = [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ];
    const nonStringQuestion = JSON.stringify({
      questions: [
        {
          header: "H",
          question: { bad: true } as unknown as string,
          options: baseOptions,
          multiSelect: false,
        },
      ],
    });
    expect(getQuestionsFromApproval(approval(nonStringQuestion))).toEqual([]);
    // Two valid options so the failure is attributable to the non-string
    // `description`, not the 2–4 options bound.
    const nonStringDescription = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [
            { label: "A", description: {} } as unknown as {
              label: string;
              description: string;
            },
            { label: "B", description: "" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(getQuestionsFromApproval(approval(nonStringDescription))).toEqual(
      [],
    );
  });

  test("returns [] for unparseable/empty toolArgs", () => {
    expect(getQuestionsFromApproval(approval("{not json"))).toEqual([]);
    expect(getQuestionsFromApproval(approval(""))).toEqual([]);
  });

  test("returns [] for toolArgs that parse to a non-object (regression)", () => {
    // "null" is valid JSON parsing to null; dereferencing .questions on it
    // would throw. The shared validator must treat it as malformed.
    expect(getQuestionsFromApproval(approval("null"))).toEqual([]);
    expect(getQuestionsFromApproval(approval("true"))).toEqual([]);
    expect(getQuestionsFromApproval(approval("42"))).toEqual([]);
  });
});
