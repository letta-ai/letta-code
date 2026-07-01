import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { buildStatuslineRenderContext } from "@/cli/display/statusline/context";
import { shouldRenderDefaultStatuslineRenderer } from "@/cli/display/statusline/default-renderer-activation";
import {
  DEFAULT_STATUSLINE_RENDERER_ID,
  getBuiltinStatuslineRenderer,
  getBuiltinStatuslineRenderers,
} from "@/cli/display/statusline/registry";
import {
  buildDefaultStatuslineParts,
  getDefaultStatuslineRightColumnWidth,
} from "@/cli/display/statusline/renderers/Default";
import type { StatuslineRenderContext } from "@/cli/display/statusline/types";
import { buildStatusLinePayload } from "@/cli/helpers/status-line-payload";

const DEFAULT_STATUSLINE_ACTIVATION = {
  hideFooterContent: false,
  isBashMode: false,
  modeActive: false,
  preemptionActive: false,
  transientHintActive: false,
};

function createStatuslineContext({
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
} = {}): StatuslineRenderContext {
  return buildStatuslineRenderContext({
    payload: buildStatusLinePayload({
      agentName,
      currentDirectory: "/tmp/project",
      modelDisplayName,
      projectDirectory: "/tmp/project",
      reasoningEffort,
      terminalWidth,
      toolset,
    }),
    ui: {
      currentModelProvider: "chatgpt-plus-pro",
      hasTemporaryModelOverride: false,
      isByokProvider: false,
      isLocalBackend: true,
      isOpenAICodexProvider: false,
      rightColumnWidth,
    },
  });
}

describe("statusline renderers", () => {
  test("default renderer is built in", () => {
    expect(DEFAULT_STATUSLINE_RENDERER_ID).toBe("default");
    expect(getBuiltinStatuslineRenderer(undefined).id).toBe("default");
    expect(getBuiltinStatuslineRenderer("missing").id).toBe("default");
  });

  test("registry exposes the default renderer", () => {
    expect(
      getBuiltinStatuslineRenderers().map((renderer) => renderer.id),
    ).toEqual(["default"]);
  });

  test("context exposes broad app state and raw payload", () => {
    const context = createStatuslineContext({ toolset: "computer" });

    expect(context.rawPayload.toolset).toBe("computer");
    expect(context.toolset).toBe("computer");
    expect(context.workspace.currentDir).toBe("/tmp/project");
    expect(context.workspace.projectDir).toBe("/tmp/project");
    expect(context.components.Box).toBeDefined();
    expect(context.components.Text).toBeDefined();
    expect(context.components.Spacer).toBeDefined();
    expect(context.statuses).toEqual({});
    expect(context.agent.name).toBe("Letta Code");
    expect(context.model.displayName).toBe("GPT-5.5 (ChatGPT)");
    expect(context.model.provider).toBe("chatgpt-plus-pro");
    expect(context.model.reasoningEffort).toBe("high");
  });

  test("default renderer shows compact agent and model label", () => {
    const output = buildDefaultStatuslineParts(createStatuslineContext());

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Letta Code · GPT-5.5 (ChatGPT)",
    );
  });

  test("default renderer omits reasoning and backend labels", () => {
    const output = buildDefaultStatuslineParts(
      createStatuslineContext({ modelDisplayName: "No model selected" }),
    );

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Letta Code · No model selected",
    );
  });

  test("default renderer uses idle row width for long agent names", () => {
    const context = createStatuslineContext({
      agentName: "A Very Long Agent Name",
      modelDisplayName: "Claude",
      rightColumnWidth: 36,
      terminalWidth: 80,
    });

    expect(getDefaultStatuslineRightColumnWidth(context)).toBe(76);
    expect(
      stripAnsi(String(buildDefaultStatuslineParts(context).right)),
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
