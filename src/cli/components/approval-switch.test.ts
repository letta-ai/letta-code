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
    // A non-string `description` (e.g. {}) is rendered as a React child when
    // truthy, which throws — reject it.
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
          ],
        },
      ],
    });
    expect(getQuestions(approval(nonStringDescription))).toEqual([]);

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

  test("returns [] when the questions/options counts violate the 1–4 / 2–4 contract", () => {
    // The AskUserQuestion schema + tool implementation cap questions at 1–4 and
    // each question's options at 2–4. The validator must mirror that so a
    // payload the tool will reject on submit falls through to InlineGenericApproval
    // instead of rendering a specialized prompt the user can't successfully answer.
    const twoOptions = [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ];
    const mkQuestion = () => ({
      header: "H",
      question: "Q?",
      options: twoOptions,
      multiSelect: false,
    });
    // >4 questions
    const tooManyQuestions = JSON.stringify({
      questions: [
        mkQuestion(),
        mkQuestion(),
        mkQuestion(),
        mkQuestion(),
        mkQuestion(),
      ],
    });
    expect(getQuestions(approval(tooManyQuestions))).toEqual([]);
    // exactly 4 questions is fine
    const fourQuestions = JSON.stringify({
      questions: [mkQuestion(), mkQuestion(), mkQuestion(), mkQuestion()],
    });
    expect(getQuestions(approval(fourQuestions))).toHaveLength(4);
    // single option (< 2)
    const singleOption = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [{ label: "A", description: "" }],
          multiSelect: false,
        },
      ],
    });
    expect(getQuestions(approval(singleOption))).toEqual([]);
    // 5 options (> 4)
    const fiveOptions = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [
            { label: "1", description: "" },
            { label: "2", description: "" },
            { label: "3", description: "" },
            { label: "4", description: "" },
            { label: "5", description: "" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(getQuestions(approval(fiveOptions))).toEqual([]);
  });

  test("returns [] when question-level fields have the wrong type", () => {
    // InlineQuestionApproval calls `question.includes(...)` and renders
    // `header` as a React child, so non-string values throw. multiSelect/
    // allowOther must be booleans (allowOther may be omitted).
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
    expect(getQuestions(approval(nonStringQuestion))).toEqual([]);
    const nonStringHeader = JSON.stringify({
      questions: [
        {
          header: { bad: true } as unknown as string,
          question: "Q?",
          options: baseOptions,
          multiSelect: false,
        },
      ],
    });
    expect(getQuestions(approval(nonStringHeader))).toEqual([]);
    const nonBooleanMultiSelect = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: baseOptions,
          multiSelect: "yes" as unknown as boolean,
        },
      ],
    });
    expect(getQuestions(approval(nonBooleanMultiSelect))).toEqual([]);
    const missingMultiSelect = JSON.stringify({
      questions: [{ header: "H", question: "Q?", options: baseOptions }],
    });
    expect(getQuestions(approval(missingMultiSelect))).toEqual([]);
    const nonBooleanAllowOther = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: baseOptions,
          multiSelect: false,
          allowOther: "yes" as unknown as boolean,
        },
      ],
    });
    expect(getQuestions(approval(nonBooleanAllowOther))).toEqual([]);
    // allowOther omitted is fine (it's optional).
    const validWithoutAllowOther = JSON.stringify({
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
    expect(getQuestions(approval(validWithoutAllowOther))).toHaveLength(1);
  });

  test("returns [] if any single question is malformed (all-or-nothing)", () => {
    // The first question is fully well-formed (2 options + multiSelect); only
    // the second is malformed (missing options). This pins all-or-nothing: the
    // validator must reject the whole batch because of the bad entry, not
    // because the good one also happens to be invalid.
    const mixed = JSON.stringify({
      questions: [
        {
          header: "H",
          question: "Q?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
          multiSelect: false,
        },
        { header: "H2", question: "Q2?", multiSelect: false }, // missing options
      ],
    });
    expect(getQuestions(approval(mixed))).toEqual([]);
  });

  test("returns [] for unparseable toolArgs", () => {
    expect(getQuestions(approval("{not valid json"))).toEqual([]);
  });

  test("returns [] for toolArgs that parse to a non-object (regression)", () => {
    // `safeJsonParseOr` returns the raw JSON.parse result, so valid-but-
    // non-object JSON (e.g. "null", "true", "42", "\"x\"") flows through.
    // `null` in particular must not reach `parsed.questions` (throws and
    // bricks the TUI via the render path).
    expect(getQuestions(approval("null"))).toEqual([]);
    expect(getQuestions(approval("true"))).toEqual([]);
    expect(getQuestions(approval("42"))).toEqual([]);
    expect(getQuestions(approval('"a string"'))).toEqual([]);
  });

  test("returns [] for empty toolArgs", () => {
    expect(getQuestions(approval(""))).toEqual([]);
  });
});
