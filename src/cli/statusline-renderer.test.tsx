import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { shouldRenderDefaultStatuslineRenderer } from "@/cli/display/statusline/default-renderer-activation";
import {
  buildDefaultStatuslineParts,
  getDefaultStatuslineRightColumnWidth,
} from "@/cli/display/statusline/renderers/Default";
import type { StatuslineUiContext } from "@/cli/display/statusline/types";
import { buildCliModContext } from "@/cli/helpers/cli-mod-context";
import type { ModContext } from "@/mods/types";

const DEFAULT_STATUSLINE_ACTIVATION = {
  hideFooterContent: false,
  isBashMode: false,
  modeActive: false,
  preemptionActive: false,
  transientHintActive: false,
};

function createStatuslineFixture({
  agentName = "Letta Code",
  modelDisplayName = "GPT-5.5 (ChatGPT)",
  reasoningEffort = "high",
  rightColumnWidth = 80,
  terminalWidth = 120,
  toolset = "letta-code",
}: {
  agentName?: string;
  modelDisplayName?: string;
  reasoningEffort?: string;
  rightColumnWidth?: number;
  terminalWidth?: number;
  toolset?: string;
} = {}): { context: ModContext; ui: StatuslineUiContext } {
  return {
    context: buildCliModContext({
      agentName,
      currentDirectory: "/tmp/project",
      modelDisplayName,
      modelProvider: "chatgpt-plus-pro",
      projectDirectory: "/tmp/project",
      reasoningEffort,
      terminalWidth,
      toolset,
    }),
    ui: {
      hasTemporaryModelOverride: false,
      isByokProvider: false,
      isOpenAICodexProvider: false,
      rightColumnWidth,
    },
  };
}

describe("statusline renderers", () => {
  test("CLI mod context exposes broad app state", () => {
    const { context } = createStatuslineFixture({ toolset: "computer" });

    expect(context.toolset).toBe("computer");
    expect(context.workspace.currentDir).toBe("/tmp/project");
    expect(context.workspace.projectDir).toBe("/tmp/project");
    expect(context.agent.name).toBe("Letta Code");
    expect(context.model.displayName).toBe("GPT-5.5 (ChatGPT)");
    expect(context.model.provider).toBe("chatgpt-plus-pro");
    expect(context.model.reasoningEffort).toBe("high");
  });

  test("default renderer shows compact agent and model label", () => {
    const { context, ui } = createStatuslineFixture();
    const output = buildDefaultStatuslineParts(context, ui);

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Letta Code · GPT-5.5 (ChatGPT)",
    );
  });

  test("default renderer omits reasoning and backend labels", () => {
    const { context, ui } = createStatuslineFixture({
      modelDisplayName: "No model selected",
    });
    const output = buildDefaultStatuslineParts(context, ui);

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Letta Code · No model selected",
    );
  });

  test("default renderer uses idle row width for long agent names", () => {
    const { context, ui } = createStatuslineFixture({
      agentName: "A Very Long Agent Name",
      modelDisplayName: "Claude",
      rightColumnWidth: 36,
      terminalWidth: 80,
    });

    expect(getDefaultStatuslineRightColumnWidth(context, ui)).toBe(76);
    expect(
      stripAnsi(String(buildDefaultStatuslineParts(context, ui).right)),
    ).toContain("A Very Long Agent Name");
  });

  test("default renderer does not override safety preemptions", () => {
    expect(
      shouldRenderDefaultStatuslineRenderer({
        ...DEFAULT_STATUSLINE_ACTIVATION,
        preemptionActive: true,
      }),
    ).toBe(false);
  });

  test("default renderer does not override transient host hints", () => {
    expect(
      shouldRenderDefaultStatuslineRenderer({
        ...DEFAULT_STATUSLINE_ACTIVATION,
        transientHintActive: true,
      }),
    ).toBe(false);
  });
});
