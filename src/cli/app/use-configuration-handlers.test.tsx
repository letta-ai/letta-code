import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { render } from "ink";
import { type ComponentProps, useState } from "react";
import stripAnsi from "strip-ansi";
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

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${description}`);
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

async function renderPickerForSelection(selection: ModelSelectorSelection) {
  const captured: {
    handlers?: Handlers;
    prompt?: Prompt;
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
        onSelect={() => {}}
        onCancel={() => setPrompt(null)}
      />
    ) : null;
  }
  const stdout = new CaptureStream();
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
    await waitFor(() => captured.handlers !== undefined, "handler mount");
    await captured.handlers?.handleModelSelect(selection);
    await waitFor(
      () =>
        stripAnsi(stdout.chunks.join("")).includes(
          "Set your model's reasoning settings",
        ),
      "reasoning picker",
    );
    return {
      output: stripAnsi(stdout.chunks.join("")),
      options: captured.prompt?.options ?? [],
    };
  } finally {
    instance.unmount();
    instance.cleanup();
    stdin.destroy();
    stdout.destroy();
  }
}

describe("model reasoning picker", () => {
  test("renders the picker for a local ChatGPT OAuth model", async () => {
    const model = getBuiltinModels("openai-codex").find(
      (entry) => entry.id === "gpt-5.6-sol",
    );
    if (!model) throw new Error("Missing GPT-5.6 Sol from pi-ai catalog");
    const handle = `openai-codex/${model.id}`;
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

    const result = await renderPickerForSelection({
      id: handle,
      handle,
      label: model.name,
      description: "",
      registryHandle: registryHandleForBackendModel(handle, "chatgpt_oauth"),
      updateArgs: {
        provider_type: "chatgpt_oauth",
        context_window: model.contextWindow,
      },
    });

    expect(result.output).toContain("Set your model's reasoning settings");
    expect(result.options.map((option) => option.effort)).toEqual(
      levels.map((level) => (level === "off" ? "none" : level)),
    );
  });
});
