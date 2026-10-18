import { describe, expect, test } from "bun:test";
import {
  tuiQueuedClientPreferences,
  tuiSubmitClientPreferences,
} from "./tui-client-preferences";

describe("native TUI client preference origin", () => {
  test("ordinary user submissions clear inherited client additions", () => {
    expect(tuiSubmitClientPreferences(false)).toEqual({});
    expect(tuiSubmitClientPreferences(false, { userInitiated: true })).toEqual(
      {},
    );
  });

  test("automatic task and cron submissions retain the prior snapshot", () => {
    expect(tuiSubmitClientPreferences(true)).toBeUndefined();
    expect(
      tuiSubmitClientPreferences(false, { userInitiated: false }),
    ).toBeUndefined();
  });

  test("tool continuation without user input does not clear preferences", () => {
    expect(tuiQueuedClientPreferences(null)).toBeUndefined();
    expect(tuiQueuedClientPreferences([])).toBeUndefined();
    expect(
      tuiQueuedClientPreferences([
        { kind: "task_notification", text: "done" },
        { kind: "user", source: "cron", text: "scheduled prompt" },
      ]),
    ).toBeUndefined();
  });

  test("a human message in a mixed automatic batch clears preferences", () => {
    expect(
      tuiQueuedClientPreferences([
        { kind: "task_notification", text: "done" },
        { kind: "user", source: "cron", text: "scheduled prompt" },
        { kind: "user", text: "new request" },
      ]),
    ).toEqual({});
  });
});
