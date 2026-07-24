import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  type AuthMethod,
  type ByokProvider,
  checkProviderApiKey,
  createOrUpdateProvider,
  defaultProviderApiKey,
  defaultProviderStorageTarget,
  getConnectedProviders,
  getProviderConfigs,
  type ProviderField,
  type ProviderResponse,
  type ProviderStorageTarget,
  removeProviderByName,
} from "@/providers/byok-providers";
import {
  formatChatGPTUsageQuotaRows,
  readChatGPTUsage,
} from "@/providers/chatgpt-usage-service";
import { normalizeChatGPTOAuthProviderName } from "@/providers/openai-codex-provider";
import { connectedRecordsForProvider } from "@/providers/provider-connections";
import { type Settings, settingsManager } from "@/settings-manager";
import { type AwsProfile, parseAwsCredentials } from "@/utils/aws-credentials";
import { debugLog } from "@/utils/debug";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const VISIBLE_PROVIDERS = 8;

type ViewState =
  | { type: "list" }
  | { type: "input"; provider: ByokProvider }
  | { type: "multiInput"; provider: ByokProvider; authMethod?: AuthMethod }
  | { type: "methodSelect"; provider: ByokProvider }
  | { type: "profileSelect"; provider: ByokProvider }
  | { type: "options"; provider: ByokProvider }
  | { type: "oauthNameInput"; provider: ByokProvider };

type ValidationState = "idle" | "validating" | "valid" | "invalid" | "saving";

type ProviderSelectionFlow =
  | "options"
  | "oauth"
  | "methodSelect"
  | "multiInput"
  | "input";

type ConnectedProvidersByTarget = Partial<
  Record<ProviderStorageTarget, Map<string, ProviderResponse>>
>;

type ChatGPTUsageStatus =
  | { status: "loading" }
  | { status: "ready"; rows: string[] }
  | { status: "error"; message: string };

interface ProviderSelectorProps {
  onCancel: () => void;
  /** Called when an OAuth flow should start */
  onStartOAuth?: (
    provider: ByokProvider,
    target: ProviderStorageTarget,
    providerName?: string,
  ) => void;
}

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

function usageStatusRows(status: ChatGPTUsageStatus | undefined): string[] {
  if (!status || status.status === "loading") return ["Loading..."];
  if (status.status === "error") return [`Unavailable: ${status.message}`];
  return status.rows;
}

export function ProviderSelector({
  onCancel,
  onStartOAuth,
}: ProviderSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  // State
  const [selectedTarget, setSelectedTarget] = useState<ProviderStorageTarget>(
    defaultProviderStorageTarget(),
  );
  const [hasCloudCredentials, setHasCloudCredentials] = useState<
    boolean | null
  >(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [connectedProvidersByTarget, setConnectedProvidersByTarget] =
    useState<ConnectedProvidersByTarget>({});
  const [loadingTargets, setLoadingTargets] = useState<
    Set<ProviderStorageTarget>
  >(new Set());
  const [viewState, setViewState] = useState<ViewState>({ type: "list" });
  const [searchQuery, setSearchQuery] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [providerNameInput, setProviderNameInput] = useState("");
  const [providerNameError, setProviderNameError] = useState<string | null>(
    null,
  );
  const [validationState, setValidationState] =
    useState<ValidationState>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [optionIndex, setOptionIndex] = useState(0);
  const [chatGPTUsageByProvider, setChatGPTUsageByProvider] = useState<
    Record<string, ChatGPTUsageStatus>
  >({});
  // Multi-field input state (for providers like Bedrock)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [focusedFieldIndex, setFocusedFieldIndex] = useState(0);
  // Auth method selection state (for providers with multiple auth options)
  const [methodIndex, setMethodIndex] = useState(0);
  // AWS profile selection state
  const [awsProfiles, setAwsProfiles] = useState<AwsProfile[]>([]);
  const [profileIndex, setProfileIndex] = useState(0);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const providers = useMemo(
    () => getProviderConfigs(selectedTarget),
    [selectedTarget],
  );
  const filteredProviders = useMemo(
    () => filterProviderConfigs(providers, searchQuery),
    [providers, searchQuery],
  );
  const showProviderStoreTabs =
    shouldShowProviderStoreTabs(hasCloudCredentials);
  const connectedProviders = useMemo(
    () => connectedProvidersByTarget[selectedTarget] ?? new Map(),
    [connectedProvidersByTarget, selectedTarget],
  );
  const isLoading = isProviderTargetLoading({
    selectedTarget,
    connectedProvidersByTarget,
    showProviderStoreTabs,
  });
  const selectableProviders = filteredProviders;
  const providerStartIndex = useMemo(() => {
    if (selectedIndex < VISIBLE_PROVIDERS) return 0;
    return Math.min(
      selectedIndex - VISIBLE_PROVIDERS + 1,
      Math.max(0, selectableProviders.length - VISIBLE_PROVIDERS),
    );
  }, [selectedIndex, selectableProviders.length]);
  const visibleProviders = useMemo(
    () =>
      selectableProviders.slice(
        providerStartIndex,
        providerStartIndex + VISIBLE_PROVIDERS,
      ),
    [selectableProviders, providerStartIndex],
  );
  const providersBelow = Math.max(
    0,
    selectableProviders.length - providerStartIndex - VISIBLE_PROVIDERS,
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    settingsManager
      .getSettingsWithSecureTokens()
      .then((settings) => {
        if (cancelled || !mountedRef.current) return;
        setHasCloudCredentials(hasCloudProviderStoreCredentials(settings));
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setHasCloudCredentials(Boolean(process.env.LETTA_API_KEY));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setConnectedProvidersForTarget = useCallback(
    (
      target: ProviderStorageTarget,
      providers: Map<string, ProviderResponse>,
    ) => {
      setConnectedProvidersByTarget((previous) => ({
        ...previous,
        [target]: providers,
      }));
    },
    [],
  );

  const refreshConnectedProviders = useCallback(
    async (target: ProviderStorageTarget) => {
      setLoadingTargets((previous) => new Set(previous).add(target));
      try {
        const providers = await getConnectedProviders({ target });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(target, providers);
        }
      } catch {
        if (mountedRef.current) {
          setConnectedProvidersForTarget(target, new Map());
        }
      } finally {
        if (mountedRef.current) {
          setLoadingTargets((previous) => {
            const next = new Set(previous);
            next.delete(target);
            return next;
          });
        }
      }
    },
    [setConnectedProvidersForTarget],
  );

  // Load connected providers once per target while the overlay is mounted.
  useEffect(() => {
    if (selectedTarget === "api" && !showProviderStoreTabs) return;
    if (connectedProvidersByTarget[selectedTarget]) return;
    if (loadingTargets.has(selectedTarget)) return;
    void refreshConnectedProviders(selectedTarget);
  }, [
    connectedProvidersByTarget,
    loadingTargets,
    refreshConnectedProviders,
    selectedTarget,
    showProviderStoreTabs,
  ]);

  // When both tabs are available, prefetch the inactive tab so switching tabs
  // can render from overlay-local cache instead of flashing a loading state.
  useEffect(() => {
    if (!showProviderStoreTabs) return;
    for (const target of ["local", "api"] as const) {
      if (target === selectedTarget) continue;
      if (connectedProvidersByTarget[target]) continue;
      if (loadingTargets.has(target)) continue;
      void refreshConnectedProviders(target);
    }
  }, [
    connectedProvidersByTarget,
    loadingTargets,
    refreshConnectedProviders,
    selectedTarget,
    showProviderStoreTabs,
  ]);

  useEffect(() => {
    if (!showProviderStoreTabs && selectedTarget !== "local") {
      setSelectedTarget("local");
      setSelectedIndex(0);
      setSearchQuery("");
      setViewState({ type: "list" });
    }
  }, [selectedTarget, showProviderStoreTabs]);

  useEffect(() => {
    setSelectedIndex(0);
    setViewState({ type: "list" });
  }, []);

  useEffect(() => {
    if (selectableProviders.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      return;
    }

    if (selectedIndex >= selectableProviders.length) {
      setSelectedIndex(selectableProviders.length - 1);
    }
  }, [selectedIndex, selectableProviders.length]);

  const switchTarget = useCallback(() => {
    if (!showProviderStoreTabs) return;
    setSelectedTarget((target) => (target === "local" ? "api" : "local"));
    setSelectedIndex(0);
    setSearchQuery("");
    setViewState({ type: "list" });
  }, [showProviderStoreTabs]);

  const getConnectedProviderRecords = useCallback(
    (provider: ByokProvider): ProviderResponse[] =>
      connectedRecordsForProvider(provider, connectedProviders, selectedTarget),
    [connectedProviders, selectedTarget],
  );

  const getConnectedProviderName = useCallback(
    (provider: ByokProvider): string | undefined => {
      return getConnectedProviderRecords(provider)[0]?.name;
    },
    [getConnectedProviderRecords],
  );

  const loadChatGPTUsageForProvider = useCallback(
    (provider: ByokProvider, forceRefresh = false) => {
      if (!isChatGPTUsageProvider(provider)) return;

      const records = getConnectedProviderRecords(provider);
      for (const record of records) {
        const providerName = record.name;
        setChatGPTUsageByProvider((previous) => ({
          ...previous,
          [providerName]: { status: "loading" },
        }));

        void readChatGPTUsage({
          target: selectedTarget,
          providerName,
          forceRefresh,
        })
          .then((result) => {
            if (!mountedRef.current) return;
            setChatGPTUsageByProvider((previous) => ({
              ...previous,
              [providerName]: result.success
                ? {
                    status: "ready",
                    rows: formatChatGPTUsageQuotaRows(result.usage),
                  }
                : { status: "error", message: result.error.message },
            }));
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            setChatGPTUsageByProvider((previous) => ({
              ...previous,
              [providerName]: {
                status: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to read ChatGPT usage.",
              },
            }));
          });
      }
    },
    [getConnectedProviderRecords, selectedTarget],
  );

  useEffect(() => {
    if (viewState.type !== "options") return;
    loadChatGPTUsageForProvider(viewState.provider);
  }, [loadChatGPTUsageForProvider, viewState]);

  // Get provider ID if connected
  const getProviderId = useCallback(
    (provider: ByokProvider): string | undefined => {
      return getConnectedProviderRecords(provider)[0]?.id;
    },
    [getConnectedProviderRecords],
  );

  // Handle selecting a provider from the list
  const handleSelectProvider = useCallback(
    (provider: ByokProvider) => {
      const providerId = getProviderId(provider);
      const flow = providerSelectionFlow(provider, providerId);

      if (flow === "options") {
        setViewState({ type: "options", provider });
        setOptionIndex(0);
        return;
      }

      if (flow === "oauth") {
        // OAuth provider - trigger OAuth flow
        if (onStartOAuth) {
          onStartOAuth(provider, selectedTarget);
        }
        return;
      }

      if (flow === "methodSelect") {
        // Provider with multiple auth methods - show method selection
        setViewState({ type: "methodSelect", provider });
        setMethodIndex(0);
      } else if (flow === "multiInput") {
        // Multi-field provider - show multi-input view
        setViewState({ type: "multiInput", provider });
        setFieldValues(fieldValuesFromProviderPlaceholders(provider.fields));
        setFocusedFieldIndex(0);
        setValidationState("idle");
        setValidationError(null);
      } else {
        // Single API key input for regular providers
        setViewState({ type: "input", provider });
        setApiKeyInput("");
        setValidationState("idle");
        setValidationError(null);
      }
    },
    [getProviderId, onStartOAuth, selectedTarget],
  );

  // Handle selecting an auth method
  const handleSelectAuthMethod = useCallback(
    async (provider: ByokProvider, authMethod: AuthMethod) => {
      // Special handling for profile method - load AWS profiles first
      if (authMethod.id === "profile") {
        setIsLoadingProfiles(true);
        setViewState({ type: "profileSelect", provider });
        setProfileIndex(0);

        // Load profiles asynchronously
        parseAwsCredentials()
          .then((profiles) => {
            if (mountedRef.current) {
              setAwsProfiles(profiles);
              setIsLoadingProfiles(false);
            }
          })
          .catch((err) => {
            debugLog("provider", "Failed to parse AWS credentials: %O", err);
            if (mountedRef.current) {
              setAwsProfiles([]);
              setIsLoadingProfiles(false);
            }
          });
        return;
      }

      setViewState({ type: "multiInput", provider, authMethod });
      setFieldValues({});
      setFocusedFieldIndex(0);
      setValidationState("idle");
      setValidationError(null);
    },
    [],
  );

  // Handle selecting an AWS profile - pre-fill IAM fields with credentials
  const handleSelectAwsProfile = useCallback(
    (provider: ByokProvider, profile: AwsProfile) => {
      // Find the IAM auth method to use its fields
      const iamMethod =
        "authMethods" in provider
          ? provider.authMethods?.find((m) => m.id === "iam")
          : undefined;

      if (!iamMethod) return;

      // Pre-fill field values from the profile
      setFieldValues({
        accessKey: profile.accessKeyId || "",
        apiKey: profile.secretAccessKey || "",
        region: profile.region || "",
      });

      setViewState({ type: "multiInput", provider, authMethod: iamMethod });
      setFocusedFieldIndex(profile.region ? 0 : 2); // Focus region if not set
      setValidationState("idle");
      setValidationError(null);
    },
    [],
  );

  // Handle API key validation and saving
  const handleValidateAndSave = useCallback(async () => {
    if (viewState.type !== "input") return;

    const { provider } = viewState;
    const apiKey = providerApiKeyFromInput(provider, apiKeyInput);
    if (!apiKey) return;

    // If already validated, save
    if (validationState === "valid") {
      setValidationState("saving");
      try {
        await createOrUpdateProvider(
          provider.providerType,
          provider.providerName,
          apiKey,
          undefined,
          undefined,
          undefined,
          {},
          { target: selectedTarget },
        );
        clearAvailableModelsCache();
        // Refresh connected providers
        const providers = await getConnectedProviders({
          target: selectedTarget,
        });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(selectedTarget, providers);
          setViewState({ type: "list" });
          setApiKeyInput("");
          setValidationState("idle");
        }
      } catch (err) {
        if (mountedRef.current) {
          setValidationError(
            err instanceof Error ? err.message : "Failed to save",
          );
          setValidationState("invalid");
        }
      }
      return;
    }

    // Validate the key
    setValidationState("validating");
    setValidationError(null);

    try {
      await checkProviderApiKey(
        provider.providerType,
        apiKey,
        undefined,
        undefined,
        undefined,
        { target: selectedTarget },
      );
      if (mountedRef.current) {
        setValidationState("valid");
      }
    } catch (err) {
      if (mountedRef.current) {
        setValidationState("invalid");
        setValidationError(
          err instanceof Error ? err.message : "Invalid API key",
        );
      }
    }
  }, [
    viewState,
    apiKeyInput,
    validationState,
    selectedTarget,
    setConnectedProvidersForTarget,
  ]);

  // Handle multi-field validation and saving (for providers like Bedrock)
  const handleMultiFieldValidateAndSave = useCallback(async () => {
    if (viewState.type !== "multiInput") return;

    const { provider, authMethod } = viewState;
    // Get fields from authMethod if present, otherwise from provider
    const fields: ProviderField[] | undefined =
      authMethod?.fields ||
      ("fields" in provider ? (provider.fields as ProviderField[]) : undefined);
    if (!fields) return;

    // Check all required fields are filled
    const allFilled = fields.every(
      (field) => field.required === false || fieldValues[field.key]?.trim(),
    );
    if (!allFilled) return;

    const apiKey =
      fieldValues.apiKey?.trim() || defaultProviderApiKey(provider) || "";
    const accessKey = fieldValues.accessKey?.trim();
    const region = fieldValues.region?.trim();
    const profile = fieldValues.profile?.trim();
    const baseURL = fieldValues.baseUrl?.trim();

    // If already validated, save
    if (validationState === "valid") {
      setValidationState("saving");
      try {
        await createOrUpdateProvider(
          provider.providerType,
          provider.providerName,
          apiKey,
          accessKey,
          region,
          profile,
          baseURL ? { baseURL } : {},
          { target: selectedTarget },
        );
        clearAvailableModelsCache();
        // Refresh connected providers
        const providers = await getConnectedProviders({
          target: selectedTarget,
        });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(selectedTarget, providers);
          setViewState({ type: "list" });
          setFieldValues({});
          setValidationState("idle");
        }
      } catch (err) {
        if (mountedRef.current) {
          setValidationError(
            err instanceof Error ? err.message : "Failed to save",
          );
          setValidationState("invalid");
        }
      }
      return;
    }

    // Validate the credentials
    setValidationState("validating");
    setValidationError(null);

    try {
      await checkProviderApiKey(
        provider.providerType,
        apiKey,
        accessKey,
        region,
        profile,
        { target: selectedTarget },
      );
      if (mountedRef.current) {
        setValidationState("valid");
      }
    } catch (err) {
      if (mountedRef.current) {
        setValidationState("invalid");
        setValidationError(
          err instanceof Error ? err.message : "Invalid credentials",
        );
      }
    }
  }, [
    viewState,
    fieldValues,
    validationState,
    selectedTarget,
    setConnectedProvidersForTarget,
  ]);

  // Handle disconnect
  const handleDisconnect = useCallback(
    async (providerName?: string) => {
      if (viewState.type !== "options") return;

      const { provider } = viewState;
      try {
        await removeProviderByName(
          providerName ??
            getConnectedProviderName(provider) ??
            provider.providerName,
          {
            target: selectedTarget,
          },
        );
        clearAvailableModelsCache();
        // Refresh connected providers
        const providers = await getConnectedProviders({
          target: selectedTarget,
        });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(selectedTarget, providers);
          setViewState({ type: "list" });
        }
      } catch {
        // Silently fail, stay on options view
      }
    },
    [
      viewState,
      selectedTarget,
      getConnectedProviderName,
      setConnectedProvidersForTarget,
    ],
  );

  const startNamedOAuthConnect = useCallback(() => {
    if (viewState.type !== "oauthNameInput") return;

    let providerName: string;
    try {
      providerName = normalizeChatGPTOAuthProviderName(providerNameInput);
    } catch (error) {
      setProviderNameError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (connectedProviders.has(providerName)) {
      setProviderNameError(`Provider '${providerName}' already exists.`);
      return;
    }

    if (!onStartOAuth) {
      setProviderNameError("OAuth connection is unavailable.");
      return;
    }

    setProviderNameError(null);
    onStartOAuth(viewState.provider, selectedTarget, providerName);
  }, [
    viewState,
    providerNameInput,
    connectedProviders,
    onStartOAuth,
    selectedTarget,
  ]);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    // Handle based on view state
    if (viewState.type === "list") {
      if (isLoading) return;

      if (key.escape) {
        if (searchQuery) {
          setSearchQuery("");
          setSelectedIndex(0);
        } else {
          onCancel();
        }
      } else if (
        showProviderStoreTabs &&
        (key.leftArrow || key.rightArrow || key.tab)
      ) {
        switchTarget();
      } else if (key.backspace || key.delete) {
        if (searchQuery) {
          setSearchQuery((prev) => prev.slice(0, -1));
          setSelectedIndex(0);
        }
      } else if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) =>
          selectableProviders.length === 0
            ? 0
            : Math.min(selectableProviders.length - 1, prev + 1),
        );
      } else if (key.return) {
        const provider = selectableProviders[selectedIndex];
        if (provider) {
          handleSelectProvider(provider);
        }
      } else if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.return &&
        !key.tab &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.upArrow &&
        !key.downArrow
      ) {
        setSearchQuery((prev) => prev + input);
        setSelectedIndex(0);
      }
    } else if (viewState.type === "input") {
      if (key.escape) {
        // Back to list
        setViewState({ type: "list" });
        setApiKeyInput("");
        setValidationState("idle");
        setValidationError(null);
      } else if (key.return) {
        handleValidateAndSave();
      } else if (key.backspace || key.delete) {
        setApiKeyInput((prev) => prev.slice(0, -1));
        // Reset validation if key changed
        if (validationState !== "idle") {
          setValidationState("idle");
          setValidationError(null);
        }
      } else if (input && !key.ctrl && !key.meta) {
        setApiKeyInput((prev) => prev + input);
        // Reset validation if key changed
        if (validationState !== "idle") {
          setValidationState("idle");
          setValidationError(null);
        }
      }
    } else if (viewState.type === "methodSelect") {
      // Handle auth method selection
      if (
        !("authMethods" in viewState.provider) ||
        !viewState.provider.authMethods
      )
        return;
      const authMethods = viewState.provider.authMethods;

      if (key.escape) {
        // Back to list
        setViewState({ type: "list" });
        setMethodIndex(0);
      } else if (key.upArrow) {
        setMethodIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setMethodIndex((prev) => Math.min(authMethods.length - 1, prev + 1));
      } else if (key.return) {
        const selectedMethod = authMethods[methodIndex];
        if (selectedMethod) {
          handleSelectAuthMethod(viewState.provider, selectedMethod);
        }
      }
    } else if (viewState.type === "profileSelect") {
      // Handle AWS profile selection
      if (isLoadingProfiles) return;

      if (key.escape) {
        // Back to method select
        setViewState({ type: "methodSelect", provider: viewState.provider });
        setMethodIndex(0);
        setAwsProfiles([]);
        setProfileIndex(0);
      } else if (key.upArrow) {
        setProfileIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setProfileIndex((prev) => Math.min(awsProfiles.length - 1, prev + 1));
      } else if (key.return) {
        const selectedProfile = awsProfiles[profileIndex];
        if (selectedProfile) {
          handleSelectAwsProfile(viewState.provider, selectedProfile);
        }
      }
    } else if (viewState.type === "multiInput") {
      // Get fields from authMethod if present, otherwise from provider
      const fields: ProviderField[] | undefined =
        viewState.authMethod?.fields ||
        ("fields" in viewState.provider
          ? (viewState.provider.fields as ProviderField[])
          : undefined);
      if (!fields) return;
      const currentField = fields[focusedFieldIndex];
      if (!currentField) return;

      if (key.escape) {
        // Back to method select if provider has authMethods, otherwise back to list
        if (
          "authMethods" in viewState.provider &&
          viewState.provider.authMethods
        ) {
          setViewState({ type: "methodSelect", provider: viewState.provider });
          setMethodIndex(0);
        } else {
          setViewState({ type: "list" });
        }
        setFieldValues({});
        setFocusedFieldIndex(0);
        setValidationState("idle");
        setValidationError(null);
      } else if (key.tab) {
        // Move to next/prev field
        if (key.shift) {
          setFocusedFieldIndex((prev) => Math.max(0, prev - 1));
        } else {
          setFocusedFieldIndex((prev) => Math.min(fields.length - 1, prev + 1));
        }
      } else if (key.upArrow) {
        setFocusedFieldIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setFocusedFieldIndex((prev) => Math.min(fields.length - 1, prev + 1));
      } else if (key.return) {
        handleMultiFieldValidateAndSave();
      } else if (key.backspace || key.delete) {
        setFieldValues((prev) => ({
          ...prev,
          [currentField.key]: (prev[currentField.key] || "").slice(0, -1),
        }));
        // Reset validation if value changed
        if (validationState !== "idle") {
          setValidationState("idle");
          setValidationError(null);
        }
      } else if (input && !key.ctrl && !key.meta) {
        setFieldValues((prev) => ({
          ...prev,
          [currentField.key]: (prev[currentField.key] || "") + input,
        }));
        // Reset validation if value changed
        if (validationState !== "idle") {
          setValidationState("idle");
          setValidationError(null);
        }
      }
    } else if (viewState.type === "options") {
      const connectedRecords = getConnectedProviderRecords(viewState.provider);
      const canConnectAnother = canConnectAnotherProvider(
        viewState.provider,
        selectedTarget,
      );
      const showUsageRefresh =
        isChatGPTUsageProvider(viewState.provider) &&
        connectedRecords.length > 0;
      const connectAnotherIndex = connectedRecords.length;
      const usageRefreshIndex =
        connectAnotherIndex + (canConnectAnother ? 1 : 0);
      const backIndex = usageRefreshIndex + (showUsageRefresh ? 1 : 0);
      const optionsLength = backIndex + 1;
      if (key.escape) {
        setViewState({ type: "list" });
      } else if (key.upArrow) {
        setOptionIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setOptionIndex((prev) => Math.min(optionsLength - 1, prev + 1));
      } else if (key.return) {
        if (optionIndex < connectedRecords.length) {
          handleDisconnect(connectedRecords[optionIndex]?.name);
        } else if (canConnectAnother && optionIndex === connectAnotherIndex) {
          setProviderNameInput(
            nextProviderConnectionName(viewState.provider, connectedRecords),
          );
          setProviderNameError(null);
          setViewState({
            type: "oauthNameInput",
            provider: viewState.provider,
          });
        } else if (showUsageRefresh && optionIndex === usageRefreshIndex) {
          loadChatGPTUsageForProvider(viewState.provider, true);
        } else {
          setViewState({ type: "list" });
        }
      }
    } else if (viewState.type === "oauthNameInput") {
      if (key.escape) {
        setProviderNameError(null);
        setViewState({ type: "options", provider: viewState.provider });
      } else if (key.return) {
        startNamedOAuthConnect();
      } else if (key.backspace || key.delete) {
        setProviderNameInput((prev) => prev.slice(0, -1));
        setProviderNameError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setProviderNameInput((prev) => prev + input);
        setProviderNameError(null);
      }
    }
  });

  // Mask API key for display
  const maskApiKey = (key: string): string => {
    if (key.length <= 8) return "*".repeat(key.length);
    return key.slice(0, 4) + "*".repeat(Math.min(key.length - 4, 20));
  };

  // Render list view
  const renderListView = () => (
    <>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Connect your LLM API keys
        </Text>
        <Text dimColor>Change models with /model after connecting</Text>
        {showProviderStoreTabs && (
          <Box marginTop={1} flexDirection="row">
            <Text>{"  "}</Text>
            <Text
              bold={selectedTarget === "local"}
              color={
                selectedTarget === "local"
                  ? colors.selector.title
                  : colors.command.running
              }
            >
              {selectedTarget === "local" ? "[ Local ]" : "  Local  "}
            </Text>
            <Text>{"  "}</Text>
            <Text
              bold={selectedTarget === "api"}
              color={
                selectedTarget === "api"
                  ? colors.selector.title
                  : colors.command.running
              }
            >
              {selectedTarget === "api" ? "[ Cloud ]" : "  Cloud  "}
            </Text>
          </Box>
        )}
        {!showProviderStoreTabs && <Box height={1} />}
        <Text>
          <Text dimColor>{"  Filter: "}</Text>
          {searchQuery ? (
            <Text>{searchQuery}</Text>
          ) : (
            <Text dimColor>(type to filter)</Text>
          )}
        </Text>
      </Box>

      {isLoading ? (
        <Box>
          <Text dimColor>{"  "}Loading providers...</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {selectableProviders.length === 0 && searchQuery ? (
            <Text dimColor>{"  "}No providers match your filter.</Text>
          ) : null}
          {visibleProviders.map((provider, index) => {
            const actualIndex = providerStartIndex + index;
            const isSelected = actualIndex === selectedIndex;
            const connectedRecords = getConnectedProviderRecords(provider);
            const connected = connectedRecords.length > 0;

            return (
              <Box key={provider.id} flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text color={connected ? "green" : undefined}>
                  [{connected ? "✓" : " "}]
                </Text>
                <Text> </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {provider.displayName}
                </Text>
                <Text dimColor>
                  {" · "}
                  {connected ? (
                    <Text color="green">
                      {connectedProviderSummary(provider, connectedRecords)}
                    </Text>
                  ) : (
                    provider.description
                  )}
                </Text>
              </Box>
            );
          })}
          {providersBelow > 0 ? (
            <Text dimColor>
              {"  "}↓ {providersBelow} more below
            </Text>
          ) : selectableProviders.length > VISIBLE_PROVIDERS ? (
            <Text> </Text>
          ) : null}
        </Box>
      )}

      {!isLoading && (
        <Box marginTop={1}>
          <Text dimColor>
            {searchQuery
              ? showProviderStoreTabs
                ? "  Enter select · ↑↓ navigate · Backspace edit filter · Tab/←→ switch tab · Esc clear"
                : "  Enter select · ↑↓ navigate · Backspace edit filter · Esc clear"
              : showProviderStoreTabs
                ? "  Enter select · ↑↓ navigate · type filter · Tab/←→ switch tab · Esc cancel"
                : "  Enter select · ↑↓ navigate · type filter · Esc cancel"}
          </Text>
        </Box>
      )}
    </>
  );

  // Render input view
  const renderInputView = () => {
    if (viewState.type !== "input") return null;
    const { provider } = viewState;
    const hasDefaultApiKey = defaultProviderApiKey(provider) !== undefined;
    const hasTypedApiKey = Boolean(apiKeyInput.trim());

    const statusText =
      validationState === "validating"
        ? " (validating...)"
        : validationState === "saving"
          ? " (saving & syncing models...)"
          : validationState === "valid"
            ? " (key validated!)"
            : validationState === "invalid"
              ? ` (invalid key${validationError ? `: ${validationError}` : ""})`
              : "";

    const statusColor =
      validationState === "valid"
        ? "green"
        : validationState === "invalid"
          ? "red"
          : undefined;

    const footerText =
      validationState === "saving"
        ? "Saving provider..."
        : validationState === "valid"
          ? "Enter to save · Esc cancel"
          : "Enter to validate · Esc cancel";

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {"  "}
            {hasDefaultApiKey
              ? `Connect ${provider.displayName} (API key optional):`
              : `Connect your ${provider.displayName} key:`}
          </Text>
        </Box>

        <Box flexDirection="row">
          <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
          <Text>
            {apiKeyInput
              ? maskApiKey(apiKeyInput)
              : hasDefaultApiKey
                ? "(press Enter for default key)"
                : "(enter key)"}
          </Text>
          <Text
            color={statusColor}
            dimColor={
              validationState === "validating" || validationState === "saving"
            }
          >
            {statusText}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {"  "}
            {hasDefaultApiKey && !hasTypedApiKey && validationState === "idle"
              ? "Enter to validate with default key · Esc cancel"
              : footerText}
          </Text>
        </Box>
      </>
    );
  };

  // Render method select view (for providers with multiple auth options)
  const renderMethodSelectView = () => {
    if (viewState.type !== "methodSelect") return null;
    if (
      !("authMethods" in viewState.provider) ||
      !viewState.provider.authMethods
    )
      return null;

    const { provider } = viewState;
    const authMethods = viewState.provider.authMethods;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
          <Text dimColor>Select authentication method</Text>
        </Box>

        <Box flexDirection="column">
          {authMethods.map((method, index) => {
            const isSelected = index === methodIndex;
            return (
              <Box key={method.id} flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {method.label}
                </Text>
                <Text dimColor> · {method.description}</Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc back</Text>
        </Box>
      </>
    );
  };

  // Render AWS profile select view
  const renderProfileSelectView = () => {
    if (viewState.type !== "profileSelect") return null;

    const { provider } = viewState;

    if (isLoadingProfiles) {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
          <Text dimColor>Loading AWS profiles...</Text>
        </Box>
      );
    }

    if (awsProfiles.length === 0) {
      return (
        <>
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={colors.selector.title}>
              Connect {provider.displayName}
            </Text>
            <Text color="yellow">No AWS profiles found</Text>
            <Text dimColor>
              Check that ~/.aws/credentials exists and contains valid profiles.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{"  "}Esc back</Text>
          </Box>
        </>
      );
    }

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
          <Text dimColor>Select AWS profile from ~/.aws/credentials</Text>
        </Box>

        <Box flexDirection="column">
          {awsProfiles.map((profile, index) => {
            const isSelected = index === profileIndex;
            const hasCredentials =
              profile.accessKeyId && profile.secretAccessKey;
            return (
              <Box key={profile.name} flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {profile.name}
                </Text>
                <Text dimColor>
                  {" · "}
                  {hasCredentials ? (
                    <>
                      {profile.accessKeyId?.slice(0, 8)}...
                      {profile.region && ` · ${profile.region}`}
                    </>
                  ) : (
                    <Text color="yellow">missing credentials</Text>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc back</Text>
        </Box>
      </>
    );
  };

  // Render multi-input view (for providers like Bedrock)
  const renderMultiInputView = () => {
    if (viewState.type !== "multiInput") return null;

    const { provider, authMethod } = viewState;
    // Get fields from authMethod if present, otherwise from provider
    const fields: ProviderField[] | undefined =
      authMethod?.fields ||
      ("fields" in provider ? (provider.fields as ProviderField[]) : undefined);
    if (!fields) return null;

    // Check if all required fields are filled
    const allFilled = fields.every(
      (field: ProviderField) =>
        field.required === false || fieldValues[field.key]?.trim(),
    );

    const statusText =
      validationState === "validating"
        ? " (validating...)"
        : validationState === "saving"
          ? " (saving & syncing models...)"
          : validationState === "valid"
            ? " (credentials validated!)"
            : validationState === "invalid"
              ? ` (invalid${validationError ? `: ${validationError}` : ""})`
              : "";

    const statusColor =
      validationState === "valid"
        ? "green"
        : validationState === "invalid"
          ? "red"
          : undefined;

    const hasAuthMethods = "authMethods" in provider && provider.authMethods;
    const escText = hasAuthMethods ? "Esc back" : "Esc cancel";
    const footerText =
      validationState === "saving"
        ? "Saving provider..."
        : validationState === "valid"
          ? `Enter to save · ${escText}`
          : allFilled
            ? `Enter to validate · Tab/↑↓ navigate · ${escText}`
            : `Tab/↑↓ navigate · ${escText}`;

    // Build title - include auth method name if present
    const title = authMethod
      ? `${provider.displayName} · ${authMethod.label}`
      : provider.displayName;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {title}
          </Text>
        </Box>

        <Box flexDirection="column">
          {fields.map((field: ProviderField, index: number) => {
            const isFocused = index === focusedFieldIndex;
            const value = fieldValues[field.key] || "";
            const displayValue = field.secret ? maskApiKey(value) : value;

            return (
              <Box key={field.key} flexDirection="row">
                <Text
                  color={
                    isFocused ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isFocused ? "> " : "  "}
                </Text>
                <Text dimColor={!isFocused} bold={isFocused}>
                  {field.label}
                  {field.required === false ? " (optional)" : ""}:
                </Text>
                <Text> </Text>
                <Text
                  color={
                    isFocused ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {displayValue ||
                    (isFocused
                      ? `(${field.placeholder || "enter value"})`
                      : "")}
                </Text>
              </Box>
            );
          })}
        </Box>

        {(validationState !== "idle" || validationError) && (
          <Box marginTop={1}>
            <Text
              color={statusColor}
              dimColor={
                validationState === "validating" || validationState === "saving"
              }
            >
              {"  "}
              {statusText}
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            {"  "}
            {footerText}
          </Text>
        </Box>
      </>
    );
  };

  // Render options view (for connected providers)
  const renderOptionsView = () => {
    if (viewState.type !== "options") return null;
    const { provider } = viewState;
    const connectedRecords = getConnectedProviderRecords(provider);
    const canConnectAnother = canConnectAnotherProvider(
      provider,
      selectedTarget,
    );
    const showUsage = isChatGPTUsageProvider(provider);
    const options = [
      ...connectedRecords.map((record) => `Disconnect ${record.name}`),
      ...(canConnectAnother ? [connectAnotherProviderOption(provider)] : []),
      ...(showUsage && connectedRecords.length > 0 ? ["Refresh usage"] : []),
      "Back",
    ];

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Manage {provider.displayName}
          </Text>
          <Box height={1} />
          {connectedRecords.length > 0 ? (
            connectedRecords.map((record) => {
              const usageStatus = chatGPTUsageByProvider[record.name];
              return (
                <Box key={record.id} flexDirection="column">
                  <Box flexDirection="row">
                    <Text>{"  "}</Text>
                    <Text color="green">[✓]</Text>
                    <Text> </Text>
                    <Text bold>{record.name}</Text>
                    <Text dimColor> · </Text>
                    <Text color="green">Connected</Text>
                  </Box>
                  {showUsage && (
                    <Box flexDirection="column">
                      {usageStatusRows(usageStatus).map((row) => (
                        <Box key={row} flexDirection="row">
                          <Text>{"      "}</Text>
                          <Text
                            color={
                              usageStatus?.status === "error"
                                ? "yellow"
                                : undefined
                            }
                            dimColor={usageStatus?.status !== "error"}
                          >
                            {row}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              );
            })
          ) : (
            <Text dimColor>{"  "}No connected providers.</Text>
          )}
        </Box>

        <Box flexDirection="column">
          {options.map((option, index) => {
            const isSelected = index === optionIndex;
            return (
              <Box key={option} flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {option}
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter confirm · ↑↓ navigate · Esc back</Text>
        </Box>
      </>
    );
  };

  const renderOAuthNameInputView = () => {
    if (viewState.type !== "oauthNameInput") return null;
    const { provider } = viewState;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect another {provider.displayName}
          </Text>
          <Box height={1} />
          <Box flexDirection="row">
            <Text>{"  "}Provider name: </Text>
            <Text>{providerNameInput}</Text>
          </Box>
          {providerNameError ? (
            <Box marginTop={1}>
              <Text color="red">
                {"  "}
                {providerNameError}
              </Text>
            </Box>
          ) : null}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter connect · Backspace edit · Esc back</Text>
        </Box>
      </>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /connect"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {viewState.type === "list" && renderListView()}
      {viewState.type === "input" && renderInputView()}
      {viewState.type === "methodSelect" && renderMethodSelectView()}
      {viewState.type === "profileSelect" && renderProfileSelectView()}
      {viewState.type === "multiInput" && renderMultiInputView()}
      {viewState.type === "options" && renderOptionsView()}
      {viewState.type === "oauthNameInput" && renderOAuthNameInputView()}
    </Box>
  );
}
