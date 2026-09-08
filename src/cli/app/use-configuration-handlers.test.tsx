import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { render } from "ink";
import { type ComponentProps, useState } from "react";
import stripAnsi from "strip-ansi";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { models } from "@/agent/model";
import { toRuntimeCatalogModels } from "@/agent/remote-model-catalog";
import { ModelReasoningSelector } from "@/cli/components/ModelReasoningSelector";
import {
  type ModelSelectorSelection,
  registryHandleForBackendModel,
} from "@/cli/components/ModelSelector";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { useConfigurationHandlers } from "./use-configuration-handlers";

setupRuntimeModelCatalogFixture();
afterEach(clearAvailableModelsCache);

type Handlers = ReturnType<typeof useConfigurationHandlers>;
type Context = Parameters<typeof useConfigurationHandlers>[0];
type Prompt = Omit<
  ComponentProps<typeof ModelReasoningSelector>,
  "onSelect" | "onCancel"
> | null;

class CaptureStream extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

function createContext(): Context {
  const noop = () => {};
  const command = {
    id: "test-model-command",
    input: "/model",
    update: noop,
    finish: noop,
    fail: noop,
  };
  return {
    activeOverlay: "model",
    agentId: "test-agent",
    agentIdRef: { current: "test-agent" },
    agentState: null,
    commandRunner: { start: () => command, getHandle: () => command },
    consumeOverlayCommand: () => null,
    contextTrackerRef: { current: createContextTracker() },
    conversationIdRef: { current: "test-conversation" },
    currentModelHandle: null,
    currentModelId: null,
    currentReasoningEffort: null,
    currentToolset: null,
    isAgentBusy: () => true,
    llmConfig: null,
    llmConfigRef: { current: null },
    maybeRecordToolsetChangeReminder: noop,
    resetPendingReasoningCycle: noop,
    setActiveOverlay: noop,
    setAgentState: noop,
    setConversationOverrideContextWindowLimit: noop,
    setConversationOverrideModelSettings: noop,
    setCurrentModelHandle: noop,
    setCurrentModelId: noop,
    setHasAvailableLocalModels: noop,
    setCurrentPersonalityId: noop,
    setCurrentSystemPromptId: noop,
    setCurrentToolset: noop,
    setCurrentToolsetPreference: noop,
    setHasConversationModelOverride: noop,
    setLlmConfig: noop,
    setModelReasoningPrompt: noop,
    setQueuedOverlayAction: noop,
    setTempModelOverride: noop,
    withCommandLock: async () => {
      throw new Error("Picker tests must not write backend configuration");
    },
  };
}

async function exercisePicker(
  selection: ModelSelectorSelection,
  columns: number,
) {
  clearAvailableModelsCache();
  const captured: {
    handlers?: Handlers;
    prompt?: Prompt;
    selected?: ModelSelectorSelection;
  } = {};
  function Harness() {
    const [prompt, setPrompt] = useState<Prompt>(null);
    captured.prompt = prompt;
    captured.handlers = useConfigurationHandlers({
      ...createContext(),
      setModelReasoningPrompt: setPrompt,
    });
    return prompt ? (
      <ModelReasoningSelector
        {...prompt}
        onSelect={(option) => {
          captured.selected = option.selection;
        }}
        onCancel={() => setPrompt(null)}
      />
    ) : null;
  }
  const stdout = new CaptureStream();
  stdout.columns = columns;
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const instance = render(<Harness />, {
    stdout: stdout as CaptureStream & NodeJS.WriteStream,
    stdin,
    stderr: stdout as CaptureStream & NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(captured.handlers).toBeDefined();
    await captured.handlers?.handleModelSelect(selection);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(captured.prompt).toBeTruthy();
    const output = stripAnsi(stdout.chunks.join(""));
    expect(output).toContain("Set your model's reasoning settings");
    expect(output).toContain("Medium");
    const options = captured.prompt?.options ?? [];
    expect(options.some((option) => option.effort === "high")).toBe(true);
    stdin.push("\u001b[C");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stripAnsi(stdout.chunks.join(""))).toContain("High");
    stdin.push("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured.selected?.handle).toBe(selection.handle);
    expect(captured.selected?.updateArgs).toMatchObject({
      reasoning_effort: "high",
      provider_type: selection.updateArgs?.provider_type,
    });
    stdin.push("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured.prompt).toBeNull();
    return options;
  } finally {
    instance.unmount();
    instance.cleanup();
    stdin.destroy();
    stdout.destroy();
  }
}

describe("model reasoning picker", () => {
  for (const columns of [60, 100]) {
    test.each(["gpt-5.6-sol", "gpt-6-astra"])(
      `opens local %s reasoning and selects high at ${columns} columns`,
      async (modelId) => {
        const model = getBuiltinModels("openai-codex").find(
          (entry) => entry.id === modelId,
        );
        if (!model) throw new Error(`Missing catalog model: ${modelId}`);
        const handle = `openai-codex/${modelId}`;
        const levels = getSupportedThinkingLevels(model);
        models.splice(
          0,
          models.length,
          ...toRuntimeCatalogModels([
            {
              handle,
              label: model.name,
              providerType: "chatgpt_oauth",
              maxContextWindow: model.contextWindow,
              maxOutputTokens: model.maxTokens,
              reasoningLevels: levels,
            },
          ]),
        );
        const options = await exercisePicker(
          {
            id: handle,
            handle,
            label: model.name,
            description: "",
            registryHandle: registryHandleForBackendModel(
              handle,
              "chatgpt_oauth",
            ),
            updateArgs: {
              provider_type: "chatgpt_oauth",
              context_window: model.contextWindow,
            },
          },
          columns,
        );
        expect(options.map((option) => option.effort)).toEqual(
          levels.map((level) => (level === "off" ? "none" : level)),
        );
      },
    );
  }

  test.each([
    ["lc-openai/gpt-5.4", "openai/gpt-5.4", "openai"],
    [
      "chatgpt-personal/gpt-5.6-sol",
      "chatgpt-plus-pro/gpt-5.6-sol",
      "chatgpt_oauth",
    ],
  ])(
    "preserves Cloud alias %s and its registry tiers",
    async (handle, registryHandle, providerType) => {
      await exercisePicker(
        {
          id: handle,
          handle,
          label: handle,
          registryHandle,
          description: "",
          updateArgs: { provider_type: providerType },
        },
        100,
      );
    },
  );
});
