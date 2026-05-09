import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "../helpers/readInteractiveAppSource";

function readAppSource(): string {
  return readInteractiveAppSource();
}

describe("interaction reminder wiring", () => {
  test("command runner finish events are wired into shared reminder state", () => {
    const source = readAppSource();
    expect(source).toContain("const recordCommandReminder = useCallback(");
    expect(source).toContain(
      "enqueueCommandIoReminder(sharedReminderStateRef.current",
    );
    expect(source).toContain("onCommandFinished: recordCommandReminder");
  });

  test("model/toolset handlers enqueue toolset change reminder snapshots", () => {
    const source = readAppSource();
    expect(source).toContain(
      "const maybeRecordToolsetChangeReminder = useCallback(",
    );
    expect(source).toContain(
      "const previousToolNamesSnapshot = getToolNames();",
    );
    expect(source).toContain('source: "/model (auto toolset)"');
    expect(source).toContain('source: "/model (manual toolset override)"');
    expect(source).toContain('source: "/toolset"');
    expect(source).toContain(
      "enqueueToolsetChangeReminder(sharedReminderStateRef.current",
    );
  });
});
