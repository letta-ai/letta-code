import { describe, expect, test } from "bun:test";
import {
  ACTION_REQUIRED_PREVIEW_PREFIX,
  normalizeWindowTitleItems,
  previewLineForWindowTitleItems,
  renderActionRequiredWindowTitle,
  renderWindowTitle,
  separatorFromPrevious,
  TERMINAL_TITLE_ACTION_REQUIRED_PREFIX,
  truncateTerminalTitlePart,
  type WindowTitleData,
  type WindowTitleField,
} from "@/cli/helpers/window-title-config";

const baseData: WindowTitleData = {
  agentName: "Big Chungus",
  appName: "Letta Code",
  version: "0.0.0-test",
  conversationId: "thread-123",
  conversationSummary: "Investigate title behavior",
  projectDirectory: "/tmp/project",
  currentDirectory: "/tmp/project",
  runState: "Working",
  modelDisplayName: "GPT-5.3-Codex",
  reasoningEffort: "high",
  contextUsedPercentage: 42,
  contextRemainingPercentage: 58,
  totalInputTokens: 1200,
  totalOutputTokens: 300,
  fastMode: true,
};

function render(items: WindowTitleField[], data: WindowTitleData = baseData) {
  return renderWindowTitle(items, data);
}

describe("window title config", () => {
  test("uses Letta's agent-centric default shape: activity then agent name", () => {
    expect(
      render(["activity", "agent-name"], {
        ...baseData,
        activityFrame: "⠋",
      }),
    ).toBe("⠋ Big Chungus");
  });

  test("omits inactive activity without leaving a separator", () => {
    expect(render(["activity", "agent-name"])).toBe("Big Chungus");
  });

  test("uses Codex activity separator rule", () => {
    expect(separatorFromPrevious("activity", "project-name")).toBe(" ");
    expect(separatorFromPrevious("run-state", "activity")).toBe(" ");
    expect(separatorFromPrevious("model", "project-name")).toBe(" | ");
    expect(
      render(["project-name", "activity", "run-state"], {
        ...baseData,
        activityFrame: "⠋",
      }),
    ).toBe("project ⠋ Working");
  });

  test("renders action required like Codex and excludes run-state at runtime", () => {
    expect(
      renderActionRequiredWindowTitle(
        ["activity", "run-state", "project-name"],
        baseData,
        TERMINAL_TITLE_ACTION_REQUIRED_PREFIX,
      ),
    ).toBe("[ ! ] Action Required | project");
  });

  test("normalizes Codex legacy aliases", () => {
    expect(
      normalizeWindowTitleItems([
        "spinner",
        "project",
        "status",
        "thread",
        "context-usage",
        "session-id",
        "model-name",
      ]),
    ).toEqual([
      "activity",
      "project-name",
      "run-state",
      "thread-title",
      "context-used",
      "thread-id",
      "model",
    ]);
  });

  test("preserves configured order instead of sorting", () => {
    expect(render(["model", "project-name", "run-state"])).toBe(
      "GPT-5.3-Codex | project | Working",
    );
  });

  test("preview action-required prefix includes non-runtime exclusions", () => {
    expect(
      previewLineForWindowTitleItems(
        ["activity", "run-state", "project-name"],
        baseData,
      ),
    ).toBe(`${ACTION_REQUIRED_PREVIEW_PREFIX} | Working | project`);
  });

  test("truncates title segment like Codex", () => {
    expect(truncateTerminalTitlePart("abcdefghijklmnopqrstuvwxyz", 8)).toBe(
      "abcde...",
    );
    expect(truncateTerminalTitlePart("abcdef", 3)).toBe("abc");
  });
});
