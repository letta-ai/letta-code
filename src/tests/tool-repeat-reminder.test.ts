import { describe, expect, test } from "bun:test";
import {
  buildRepeatedToolCallReminder,
  createToolRepeatTracker,
} from "../agent/tool-repeat-reminder";

describe("tool repeat reminder", () => {
  test("returns a reminder on the third exact same tool call", () => {
    const tracker = createToolRepeatTracker();
    const call = { toolName: "Read", toolArgs: '{"file_path":"README.md"}' };

    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();

    const reminder = buildRepeatedToolCallReminder(tracker, [call]);
    expect(reminder).not.toBeNull();
    expect(reminder).toContain(
      "You have called the same tool with the exact same arguments 3 times",
    );
    expect(reminder).toContain('Read({"file_path":"README.md"})');
  });

  test("does not remind for same tool with different raw arguments", () => {
    const tracker = createToolRepeatTracker();

    expect(
      buildRepeatedToolCallReminder(tracker, [
        { toolName: "Read", toolArgs: '{"file_path":"a.ts"}' },
      ]),
    ).toBeNull();
    expect(
      buildRepeatedToolCallReminder(tracker, [
        { toolName: "Read", toolArgs: '{"file_path":"b.ts"}' },
      ]),
    ).toBeNull();
    expect(
      buildRepeatedToolCallReminder(tracker, [
        { toolName: "Read", toolArgs: '{"file_path":"c.ts"}' },
      ]),
    ).toBeNull();
  });

  test("does not canonicalize json arguments", () => {
    const tracker = createToolRepeatTracker();

    expect(
      buildRepeatedToolCallReminder(tracker, [
        { toolName: "Read", toolArgs: '{"a":1,"b":2}' },
      ]),
    ).toBeNull();
    expect(
      buildRepeatedToolCallReminder(tracker, [
        { toolName: "Read", toolArgs: '{"b":2,"a":1}' },
      ]),
    ).toBeNull();
    expect(
      buildRepeatedToolCallReminder(tracker, [
        { toolName: "Read", toolArgs: '{"a":1,"b":2}' },
      ]),
    ).toBeNull();
  });

  test("does not remind again after the threshold without reset", () => {
    const tracker = createToolRepeatTracker();
    const call = { toolName: "Glob", toolArgs: '{"pattern":"**/*.ts"}' };

    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).not.toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
  });

  test("resetting the tracker allows a future reminder", () => {
    const tracker = createToolRepeatTracker();
    const call = { toolName: "Grep", toolArgs: '{"pattern":"foo"}' };

    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).not.toBeNull();

    tracker.clear();

    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).toBeNull();
    expect(buildRepeatedToolCallReminder(tracker, [call])).not.toBeNull();
  });

  test("tracks repeated calls inside a batch", () => {
    const tracker = createToolRepeatTracker();
    const call = { toolName: "Read", toolArgs: '{"file_path":"README.md"}' };

    const reminder = buildRepeatedToolCallReminder(tracker, [call, call, call]);

    expect(reminder).not.toBeNull();
    expect(reminder).toContain('Read({"file_path":"README.md"})');
  });
});
