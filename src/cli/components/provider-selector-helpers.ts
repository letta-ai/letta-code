import {
  type ByokProvider,
  defaultProviderApiKey,
  isXaiOAuthProvider,
  type ProviderField,
  type ProviderResponse,
  type ProviderStorageTarget,
} from "@/providers/byok-providers";
import type { Settings } from "@/settings-manager";

export type ProviderSelectionFlow =
  | "options"
  | "oauth"
  | "methodSelect"
  | "multiInput"
  | "input";

export type ConnectedProvidersByTarget = Partial<
  Record<ProviderStorageTarget, Map<string, ProviderResponse>>
>;

export type ProviderManageAction =
  | { type: "disconnect"; name: string }
  | { type: "connect-another" }
  | { type: "reconnect" }
  | { type: "refresh-usage" }
  | { type: "back" };

export function providerApiKeyFromInput(
  provider: ByokProvider,
  input: string,
): string | undefined {
  return input.trim() || defaultProviderApiKey(provider);
}

export function hasCloudProviderStoreCredentials(
  settings: Pick<Settings, "env" | "refreshToken">,
  env: { LETTA_API_KEY?: string } = {
    LETTA_API_KEY: process.env.LETTA_API_KEY,
  },
): boolean {
  return Boolean(
    env.LETTA_API_KEY || settings.env?.LETTA_API_KEY || settings.refreshToken,
  );
}

export function shouldShowProviderStoreTabs(
  hasCloudCredentials: boolean | null,
): boolean {
  return hasCloudCredentials === true;
}

export function shouldForceLocalProviderTab(
  hasCloudCredentials: boolean | null,
  selectedTarget: ProviderStorageTarget,
): boolean {
  if (hasCloudCredentials === null) return false;
  return !hasCloudCredentials && selectedTarget !== "local";
}

export function connectProviderTabOrder(
  activeTarget: ProviderStorageTarget,
): ProviderStorageTarget[] {
  return activeTarget === "api" ? ["api", "local"] : ["local", "api"];
}

export function formatConnectProviderTab(
  target: ProviderStorageTarget,
  selectedTarget: ProviderStorageTarget,
): string {
  const label = target === "local" ? "Local" : "Cloud";
  return selectedTarget === target ? `[ ${label} ]` : `  ${label}  `;
}

export function filterProviderConfigs(
  providers: readonly ByokProvider[],
  query: string,
): ByokProvider[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...providers];

  return providers.filter((provider) => {
    const searchable = [
      provider.id,
      provider.displayName,
      provider.description,
      provider.providerType,
      provider.providerName,
      provider.oauthProviderId,
      ...(provider.providerNames ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return searchable.includes(normalized);
  });
}

export function providerSelectionFlow(
  provider: ByokProvider,
  connectedProviderId?: string,
): ProviderSelectionFlow {
  if (connectedProviderId) return "options";
  if (provider.isOAuth) return "oauth";
  if ("authMethods" in provider && provider.authMethods) return "methodSelect";
  if ("fields" in provider && provider.fields) return "multiInput";
  return "input";
}

export function connectedProviderSummary(
  provider: ByokProvider,
  records: readonly ProviderResponse[],
): string {
  if (records.length === 0) return provider.description;
  if (records.length > 1) return `${records.length} connected`;

  const record = records[0];
  if (!record || record.name === provider.providerName) return "Connected";
  return `Connected (${record.name})`;
}

export function canConnectAnotherProvider(
  provider: ByokProvider,
  target: ProviderStorageTarget,
): boolean {
  return (
    target === "api" &&
    provider.isOAuth === true &&
    provider.providerType === "chatgpt_oauth"
  );
}

export function canReconnectProvider(
  provider: ByokProvider,
  target: ProviderStorageTarget,
): boolean {
  return target === "api" && isXaiOAuthProvider(provider);
}

export function nextProviderConnectionName(
  provider: ByokProvider,
  records: readonly ProviderResponse[],
): string {
  const existingNames = new Set(records.map((record) => record.name));
  if (!existingNames.has(provider.providerName)) return provider.providerName;

  for (let index = 2; ; index += 1) {
    const candidate = `${provider.providerName}-${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

export function connectAnotherProviderOption(provider: ByokProvider): string {
  return `Connect another ${provider.displayName}`;
}

export function reconnectProviderOption(provider: ByokProvider): string {
  return `Reconnect ${provider.displayName}`;
}

export function providerManageActions(
  provider: ByokProvider,
  target: ProviderStorageTarget,
  connectedRecords: readonly ProviderResponse[],
): ProviderManageAction[] {
  const actions: ProviderManageAction[] = connectedRecords.map((record) => ({
    type: "disconnect",
    name: record.name,
  }));
  if (canConnectAnotherProvider(provider, target)) {
    actions.push({ type: "connect-another" });
  }
  if (canReconnectProvider(provider, target) && connectedRecords.length > 0) {
    actions.push({ type: "reconnect" });
  }
  if (isChatGPTUsageProvider(provider) && connectedRecords.length > 0) {
    actions.push({ type: "refresh-usage" });
  }
  actions.push({ type: "back" });
  return actions;
}

export function providerManageActionLabel(
  action: ProviderManageAction,
  provider: ByokProvider,
): string {
  switch (action.type) {
    case "disconnect":
      return `Disconnect ${action.name}`;
    case "connect-another":
      return connectAnotherProviderOption(provider);
    case "reconnect":
      return reconnectProviderOption(provider);
    case "refresh-usage":
      return "Refresh usage";
    case "back":
      return "Back";
  }
}

export function fieldValuesFromProviderPlaceholders(
  fields: readonly ProviderField[] | undefined,
): Record<string, string> {
  if (!fields) return {};

  // Optional fields stay empty so an untouched value is not persisted:
  // e.g. leaving the Ollama base URL blank keeps env/default resolution.
  return Object.fromEntries(
    fields
      .filter(
        (field) =>
          !field.secret && field.placeholder && field.required !== false,
      )
      .map((field) => [field.key, field.placeholder as string]),
  );
}

export function isProviderTargetLoading(input: {
  selectedTarget: ProviderStorageTarget;
  connectedProvidersByTarget: ConnectedProvidersByTarget;
  showProviderStoreTabs: boolean;
}): boolean {
  return (
    input.connectedProvidersByTarget[input.selectedTarget] === undefined &&
    (input.selectedTarget === "local" || input.showProviderStoreTabs)
  );
}

export function isChatGPTUsageProvider(provider: ByokProvider): boolean {
  return (
    provider.providerType === "chatgpt_oauth" ||
    provider.oauthProviderId === "openai-codex" ||
    provider.providerName === "chatgpt-plus-pro" ||
    (provider.providerNames ?? []).includes("openai-codex")
  );
}
