export interface CatalogModel {
  id: string;
  handle: string;
  label: string;
  description: string;
  supportsStructuredOutputs?: boolean;
  shortLabel?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  updateArgs?: Record<string, unknown>;
}

export const models: CatalogModel[] = [];

const BUILTIN_MODEL_ALIASES = new Map([
  ["auto-chat", "letta/auto-chat"],
  ["auto-fast", "letta/auto-fast"],
]);

function resolveEstablishedCliAlias(
  modelIdentifier: string,
): CatalogModel | null {
  if (modelIdentifier === "haiku") {
    return (
      models.find((model) => model.handle.includes("claude-haiku-4-5")) ?? null
    );
  }
  if (modelIdentifier === "sonnet-4.6-low") {
    const matchingModels = models.filter((model) =>
      model.handle.includes("claude-sonnet-4-6"),
    );
    const lowEffortModel = matchingModels.find(
      (model) => model.updateArgs?.reasoning_effort === "low",
    );
    if (lowEffortModel) return lowEffortModel;
    const baseModel = matchingModels[0];
    return baseModel
      ? {
          ...baseModel,
          id: modelIdentifier,
          updateArgs: {
            ...baseModel.updateArgs,
            reasoning_effort: "low",
            enable_reasoner: true,
          },
        }
      : null;
  }
  return null;
}

export function resolveCatalogModel(
  modelIdentifier: string,
): CatalogModel | null {
  const byId = models.find((model) => model.id === modelIdentifier);
  if (byId) return byId;

  const byHandle = models.find((model) => model.handle === modelIdentifier);
  if (byHandle) return byHandle;

  const cliAlias = resolveEstablishedCliAlias(modelIdentifier);
  if (cliAlias) return cliAlias;

  const matches = models.filter(
    (model) => model.handle.split("/").slice(1).join("/") === modelIdentifier,
  );
  const matchingHandles = new Set(matches.map((model) => model.handle));
  return matchingHandles.size === 1 ? (matches[0] ?? null) : null;
}

export function resolveModel(modelIdentifier: string): string | null {
  const entry = resolveCatalogModel(modelIdentifier);
  if (entry) return entry.handle;

  const builtinHandle = BUILTIN_MODEL_ALIASES.get(modelIdentifier);
  if (builtinHandle) return builtinHandle;

  return modelIdentifier.includes("/") ? modelIdentifier : null;
}

export const UNSELECTED_MODEL_HANDLE = "local/default";

export function isLettaHostedModelHandle(handle: string): boolean {
  return handle.startsWith("letta/");
}

export function getDefaultModel(): string {
  const candidates = models.filter(
    (model) => !isLettaHostedModelHandle(model.handle),
  );
  const defaultModel =
    candidates.find((model) => model.isDefault) ?? candidates[0];
  return defaultModel?.handle ?? UNSELECTED_MODEL_HANDLE;
}
