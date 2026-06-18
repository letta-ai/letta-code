import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { getQuestions } from "./ApprovalSwitch";

const approval = (toolArgs: string): ApprovalRequest => ({
  toolCallId: "tc-1",
  toolName: "AskUserQuestion",
  toolArgs,
});

const validArgs = JSON.stringify({
  questions: [
    {
      header: "Goal",
      question: "What is your goal?",
      options: [
        { label: "A", description: "opt a" },
        { label: "B", description: "opt b" },
      ],
      multiSelect: false,
    },
  ],
});

describe("getQuestions (AskUserQuestion shape validation)", () => {
  test("returns parsed questions for a well-formed payload", () => {
    const q = getQuestions(approval(validArgs));
    expect(q).toHaveLength(1);
    expect(q[0]?.header).toBe("Goal");
    expect(q[0]?.options).toHaveLength(2);
  });

  test("returns [] when `questions` is emitted as a JSON string (regression)", () => {
    // This is the exact malformed payload observed in the wild: the model
    // double-encoded `questions` as a string. The old code did
    // `args.questions as Question[]` and returned the string, whose `.length`
    // was truthy, so InlineQuestionApproval spread `questions[0].options`
    // (undefined) and crashed the TUI.
    const malformed = JSON.stringify({
      questions: JSON.stringify([
        {
          header: "Goal",
          question: "...",
          options: [{ label: "A", description: "" }],
        },
      ]),
    });
    expect(getQuestions(approval(malformed))).toEqual([]);
  });

  test("returns [] when `questions` is missing", () => {
    expect(getQuestions(approval(JSON.stringify({})))).toEqual([]);
  });

  test("returns [] when `questions` is not an array", () => {
    expect(getQuestions(approval(JSON.stringify({ questions: null })))).toEqual(
      [],
    );
    expect(getQuestions(approval(JSON.stringify({ questions: {} })))).toEqual(
      [],
    );
  });

  test("returns [] when a question is missing its `options` array", () => {
    const noOptions = JSON.stringify({
      questions: [{ header: "H", question: "Q?" }],
    });
    expect(getQuestions(approval(noOptions))).toEqual([]);
  });

  test("returns [] when a question has null/empty/non-array `options`", () => {
    const nullOptions = JSON.stringify({
      questions: [{ header: "H", question: "Q?", options: null }],
    });
    expect(getQuestions(approval(nullOptions))).toEqual([]);
    const emptyOptions = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [],
        },
      ],
    });
    expect(getQuestions(approval(emptyOptions))).toEqual([]);
    // Non-array `options` (e.g. an object or string) must be rejected too —
    // spreading a non-iterable like {} would otherwise throw downstream.
    const objectOptions = JSON.stringify({
      questions: [{ header: "H", question: "Q?", options: { a: 1 } }],
    });
    expect(getQuestions(approval(objectOptions))).toEqual([]);
    const stringOptions = JSON.stringify({
      questions: [{ header: "H", question: "Q?", options: "nope" }],
    });
    expect(getQuestions(approval(stringOptions))).toEqual([]);
  });

  test("returns [] when an `options` entry is null/non-object/missing label", () => {
    // The renderer derefs option.label (React key + display) and option.description,
    // so a null/non-object entry (e.g. options: [null]) would throw downstream.
    const nullEntry = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [null as unknown as { label: string; description: string }],
        },
      ],
    });
    expect(getQuestions(approval(nullEntry))).toEqual([]);
    const nonObjectEntry = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [42 as unknown as { label: string; description: string }],
        },
      ],
    });
    expect(getQuestions(approval(nonObjectEntry))).toEqual([]);
    const emptyLabel = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [{ label: "", description: "x" }],
        },
      ],
    });
    expect(getQuestions(approval(emptyLabel))).toEqual([]);
    const missingLabel = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [{ description: "x" }] as unknown as {
            label: string;
            description: string;
          }[],
        },
      ],
    });
    expect(getQuestions(approval(missingLabel))).toEqual([]);
    // One bad entry invalidates the whole question (all-or-nothing).
    const mixedEntries = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [
            { label: "A", description: "" },
            null as unknown as { label: string; description: string },
          ],
        },
      ],
    });
    expect(getQuestions(approval(mixedEntries))).toEqual([]);
  });

  test("returns [] if any single question is malformed (all-or-nothing)", () => {
    const mixed = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [{ label: "A", description: "" }],
        },
        { header: "H2", question: "Q2?" }, // missing options
      ],
    });
    expect(getQuestions(approval(mixed))).toEqual([]);
  });

  test("returns [] for unparseable toolArgs", () => {
    expect(getQuestions(approval("{not valid json"))).toEqual([]);
  });

  test("returns [] for empty toolArgs", () => {
    expect(getQuestions(approval(""))).toEqual([]);
  });
});
