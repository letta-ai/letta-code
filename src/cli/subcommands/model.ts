import { parseArgs } from "node:util";
import {
  type AvailableModel,
  getAvailableModelHandles,
  getCachedAvailableModels,
  getCachedModelReasoningCapabilities,
} from "@/agent/available-models";
import { getReasoningTierOptionsFromCapabilities } from "@/agent/model";
import {
  models,
  resolveCatalogModel,
  resolveModel,
} from "@/agent/model-catalog";
import {
  buildModelSettings,
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "@/agent/modify";
import { initializeModelCatalog } from "@/agent/remote-model-catalog";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";

function printUsage(): void {
  console.log(`Usage:
  letta model get [--default] [--agent <id> | --conversation <id>]
  letta model list [--byok | --hosted]
  letta model set [handle] [--reasoning <level>] [--default] [--agent <id> | --conversation <id>]

  get   Show the effective model, context limit, and full redacted model_settings.
  list  List the active backend's models, catalog IDs, and reasoning levels.
  set   Select a model handle, catalog ID, or unambiguous alias.

Options:
  --default            Use the agent default instead of the current conversation
  --agent <id>          Agent defaults; ignore the session conversation
  --conversation <id>   One conversation's model override (--conv is an alias)
  --reasoning <level>   Use a level advertised by model list for this model
  --byok               List only BYOK/user-configured models
  --hosted             List only hosted (non-BYOK) models
  --help, -h           Show this help

Without target flags, infer AGENT_ID and CONVERSATION_ID from the session.
A persisted conversation gets an override; absent/default conversation means
agent scope. Agent-default changes do not remove conversation overrides.
Selecting a model applies its settings/context defaults; reasoning-only updates
keep the model and other settings. The command does not
interrupt or restart an in-flight inference. All output is JSON.`);
}

async function printJson(value: unknown): Promise<void> {
  // Subcommands call process.exit immediately afterward. Wait for pipe writes
  // to finish so large catalogs cannot be truncated at the stdout buffer limit.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export async function runModelSubcommand(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        agent: { type: "string" },
        conversation: { type: "string" },
        conv: { type: "string" },
        reasoning: { type: "string" },
        default: { type: "boolean" },
        byok: { type: "boolean" },
        hosted: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    const [action, model] = positionals;
    if (values.help || !action || action === "help") {
      printUsage();
      return 0;
    }
    if (!["get", "list", "set"].includes(action))
      throw new Error(`Unknown model action: ${action}`);
    if (
      action === "set"
        ? positionals.length > 2 ||
          (model !== undefined && !model.trim()) ||
          (!model && values.reasoning === undefined)
        : positionals.length !== 1
    ) {
      throw new Error(
        "Usage: letta model get | list | set [handle] [--reasoning <level>] (set requires a model or --reasoning)",
      );
    }
    if (action !== "set" && values.reasoning !== undefined)
      throw new Error("--reasoning is only supported by model set");
    if (values.byok && values.hosted)
      throw new Error("Use either --byok or --hosted, not both");
    if (action !== "list" && (values.byok || values.hosted))
      throw new Error("--byok and --hosted are only supported by model list");
    if (action === "list") {
      if (
        values.agent !== undefined ||
        values.conversation !== undefined ||
        values.conv !== undefined ||
        values.default
      ) {
        throw new Error(
          "model list lists the backend catalog, not an agent; omit target flags",
        );
      }
      await settingsManager.initialize();
      const local = getBackend().capabilities.localModelCatalog;
      await initializeModelCatalog();
      let catalog = [...models];
      // The local runtime inventory is entirely user-configured, not hosted.
      if (local && values.hosted) catalog = [];
      // Cloud hosted rows only come from /models/catalog. /models adds BYOK
      // rows, never replacement/fallback hosted rows. Local/custom catalogs
      // are already projected from their runtime inventory by initialization.
      if (!local) {
        const known = new Set(catalog.map((entry) => entry.handle));
        try {
          const available = await getAvailableModelHandles();
          // BYOK handles can also have catalog presets (e.g. coding plans).
          // Use only BYOK metadata here, never the inventory's hosted/base rows.
          if (values.byok || values.hosted) {
            const byokHandles = new Set(
              available.models
                .filter((entry) => entry.providerCategory === "byok")
                .map((entry) => entry.handle),
            );
            catalog = catalog.filter((entry) =>
              values.byok
                ? byokHandles.has(entry.handle)
                : !byokHandles.has(entry.handle),
            );
          }
          catalog.push(
            ...available.models
              .filter(
                (entry) =>
                  !values.hosted &&
                  entry.providerCategory === "byok" &&
                  !known.has(entry.handle),
              )
              .map((entry) => ({
                // Keep BYOK IDs selectable without colliding with hosted aliases.
                id: entry.handle,
                handle: entry.handle,
                label: entry.label,
                description: "",
                updateArgs: { context_window: entry.maxContextWindow },
              })),
          );
        } catch (error) {
          // Never present a failed category lookup as an empty filtered result.
          if (values.byok || values.hosted) throw error;
          console.error(
            `Warning: BYOK catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await printJson(
        catalog.map((entry) => ({
          id: entry.id,
          handle: entry.handle,
          label: entry.label,
          context_window_limit: entry.updateArgs?.context_window ?? null,
          reasoning_levels: reasoningLevels(
            entry.handle,
            entry.updateArgs?.context_window,
          ),
        })),
      );
      return 0;
    }
    return runModelConfigAction(
      values,
      action === "set"
        ? { model: model?.trim(), reasoning: values.reasoning }
        : undefined,
      action === "get" ? "config" : "report",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function availableModel(handle: string): AvailableModel | undefined {
  const entry = getCachedAvailableModels()?.find(
    (row) => row.handle === handle,
  );
  return getBackend().capabilities.localModelCatalog ||
    entry?.providerCategory === "byok"
    ? entry
    : undefined;
}

function reasoningLevels(handle: string, contextWindow?: unknown): string[] {
  const available = availableModel(handle);
  if (available?.reasoningLevels) {
    return available.reasoningLevels.map((level) =>
      level === "off" ? "none" : level,
    );
  }
  const capabilities =
    available && getCachedModelReasoningCapabilities()?.get(handle);
  if (capabilities)
    return getReasoningTierOptionsFromCapabilities(handle, capabilities).map(
      (option) => option.effort,
    );
  return [
    ...new Set(
      models
        .filter(
          (entry) =>
            entry.handle === handle &&
            (contextWindow === undefined ||
              entry.updateArgs?.context_window === contextWindow),
        )
        .flatMap((entry) =>
          typeof entry.updateArgs?.reasoning_effort === "string"
            ? [entry.updateArgs.reasoning_effort]
            : [],
        ),
    ),
  ];
}

async function resolveSelection(model: string, reasoning?: string) {
  await initializeModelCatalog();
  const handle = resolveModel(model);
  if (!handle) throw new Error(`Unknown or ambiguous model: ${model}`);
  const preset = resolveCatalogModel(model);
  let updateArgs = { ...preset?.updateArgs };
  if (!preset) {
    await getAvailableModelHandles();
    const available = availableModel(handle);
    if (!available)
      throw new Error(`Model is not available on this backend: ${model}`);
    updateArgs = {
      provider_type: available.providerType,
      context_window: available.maxContextWindow,
      max_output_tokens: available.maxOutputTokens,
      openai_compatible_proxy: available.openAICompatibleProxy,
    };
  }
  if (reasoning !== undefined) {
    const levels = reasoningLevels(handle, updateArgs.context_window);
    if (!levels.includes(reasoning)) {
      throw new Error(
        `Unsupported reasoning level '${reasoning}' for ${handle}. Supported: ${levels.join(", ") || "none advertised"}`,
      );
    }
    // Select the whole reasoning preset (including thinking budgets), not just
    // an effort string that could leave thinking disabled or reset its budget.
    const tier = models.find(
      (entry) =>
        entry.handle === handle &&
        entry.updateArgs?.reasoning_effort === reasoning &&
        entry.updateArgs?.context_window === updateArgs.context_window,
    );
    updateArgs = {
      ...updateArgs,
      ...tier?.updateArgs,
      reasoning_effort: reasoning,
    };
  }
  return { handle, updateArgs };
}

const SECRET_CONFIG_FIELD =
  /api[_-]?key|access[_-]?key|secret|credential|password|authorization|(^|[_-])(auth|refresh|access|bearer)?token($|[_-])/i;

function redactConfigSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_CONFIG_FIELD.test(key)
        ? "[redacted]"
        : redactConfigSecrets(nested),
    ]),
  );
}

function contextLimit(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.context_window_limit === "number")
    return value.context_window_limit;
  if (
    isRecord(value.model_settings) &&
    typeof value.model_settings.context_window_limit === "number"
  )
    return value.model_settings.context_window_limit;
  if (
    isRecord(value.llm_config) &&
    typeof value.llm_config.context_window === "number"
  )
    return value.llm_config.context_window;
  return undefined;
}

function safeConfigEntity(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of [
    "id",
    "agent_id",
    "name",
    "model",
    "context_window_limit",
  ]) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  if (isRecord(value.model_settings))
    output.model_settings = redactConfigSecrets(value.model_settings);
  if (
    isRecord(value.llm_config) &&
    value.llm_config.context_window !== undefined
  ) {
    output.llm_config = { context_window: value.llm_config.context_window };
  }
  return output;
}

export function buildAgentConfigReport(agent: unknown, conversation: unknown) {
  if (!isRecord(agent)) throw new Error("Agent configuration is unavailable");
  const conversationRecord = isRecord(conversation) ? conversation : null;
  const conversationSettings = conversationRecord?.model_settings;
  const hasConversationOverride = Boolean(
    (typeof conversationRecord?.model === "string" &&
      conversationRecord.model.length > 0) ||
      (isRecord(conversationSettings) &&
        Object.keys(conversationSettings).length > 0) ||
      contextLimit(conversationRecord) !== undefined,
  );
  const effectiveSource = hasConversationOverride ? conversationRecord : agent;
  const effectiveSettings = isRecord(effectiveSource?.model_settings)
    ? effectiveSource.model_settings
    : isRecord(agent.model_settings)
      ? agent.model_settings
      : {};
  return {
    agent: safeConfigEntity(agent),
    conversation: safeConfigEntity(conversationRecord),
    effective: {
      scope: hasConversationOverride ? "conversation" : "agent",
      model:
        (typeof effectiveSource?.model === "string" && effectiveSource.model) ||
        agent.model ||
        null,
      context_window_limit:
        contextLimit(conversationRecord) ?? contextLimit(agent) ?? null,
      model_settings: redactConfigSecrets(effectiveSettings),
    },
    note: "model is the configured handle; router handles do not identify the underlying model selected for one inference",
  };
}

async function runModelConfigAction(
  values: {
    agent?: string;
    conversation?: string;
    conv?: string;
    default?: boolean;
  },
  update?: { model?: string; reasoning?: string },
  output: "config" | "report" = "report",
): Promise<number> {
  try {
    const explicitAgentId = values.agent;
    const conversationId = values.conversation ?? values.conv;
    if (values.conversation !== undefined && values.conv !== undefined)
      throw new Error("Use either --conversation or --conv, not both");
    if (explicitAgentId !== undefined && conversationId !== undefined)
      throw new Error("Use either --agent or --conversation, not both");
    if (values.default && conversationId !== undefined)
      throw new Error("Use either --default or --conversation, not both");
    if (
      [values.agent, values.conversation, values.conv].some(
        (value) => value !== undefined && !value.trim(),
      )
    )
      throw new Error("Agent and conversation IDs must not be empty");
    await settingsManager.initialize();
    const backend = getBackend();
    const currentConversationId =
      explicitAgentId || (values.default && process.env.AGENT_ID)
        ? undefined
        : (conversationId ?? process.env.CONVERSATION_ID);
    let agentId = explicitAgentId ?? process.env.AGENT_ID;
    let conversation = null;
    if (currentConversationId && currentConversationId !== "default") {
      conversation = await backend.retrieveConversation(currentConversationId);
      if (typeof conversation.agent_id !== "string")
        throw new Error(
          `Conversation ${currentConversationId} did not identify its parent agent`,
        );
      if (!conversationId && agentId && conversation.agent_id !== agentId) {
        throw new Error(
          `Conversation ${currentConversationId} belongs to ${conversation.agent_id}, not current AGENT_ID ${agentId}`,
        );
      }
      agentId = conversation.agent_id;
    }
    if (values.default) conversation = null;
    if (!agentId)
      throw new Error(
        "Set AGENT_ID or pass --agent/--conversation to select configuration",
      );
    let agent = await backend.retrieveAgent(agentId);
    if (update) {
      const current = buildAgentConfigReport(agent, conversation).effective;
      const selected = update.model ?? current.model;
      if (typeof selected !== "string" || !selected)
        throw new Error("Current model could not be resolved");
      const { handle, updateArgs } = await resolveSelection(
        selected,
        update.reasoning,
      );
      if (!update.model) {
        // Keep the configured model, limits, and unrelated settings. Only
        // replace provider-specific reasoning fields from the selected tier.
        const rawSettings = isRecord(conversation?.model_settings)
          ? conversation.model_settings
          : agent.model_settings;
        const settings = isRecord(rawSettings) ? { ...rawSettings } : {};
        const reasoningSettings = buildModelSettings(
          handle,
          {
            ...updateArgs,
            ...(typeof settings.provider_type === "string" && {
              provider_type: settings.provider_type,
            }),
          },
          backend.capabilities.localModelCatalog,
        );
        for (const key of [
          "reasoning",
          "reasoning_effort",
          "effort",
          "thinking",
          "thinking_config",
        ]) {
          if (key in reasoningSettings) {
            const value = (reasoningSettings as Record<string, unknown>)[key];
            settings[key] =
              isRecord(settings[key]) && isRecord(value)
                ? { ...settings[key], ...value }
                : value;
          }
        }
        if (conversation)
          await backend.updateConversation(conversation.id, {
            model_settings: settings,
          } as Parameters<typeof backend.updateConversation>[1]);
        else
          await backend.updateAgent(agentId, {
            model_settings: settings,
          } as Parameters<typeof backend.updateAgent>[1]);
        if (conversation)
          conversation = await backend.retrieveConversation(conversation.id);
      } else if (conversation) {
        await updateConversationLLMConfig(conversation.id, handle, updateArgs);
        conversation = await backend.retrieveConversation(conversation.id);
      } else {
        await updateAgentLLMConfig(agentId, handle, updateArgs);
      }
      agent = await backend.retrieveAgent(agentId);
    }
    const report = buildAgentConfigReport(agent, conversation);
    const { model, context_window_limit, model_settings } = report.effective;
    await printJson(
      output === "config"
        ? { model, context_window_limit, model_settings }
        : report,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
