import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BYOK_PROVIDERS,
  type ByokProvider,
  checkProviderApiKey,
  createOrUpdateProvider,
  getConnectedProviders,
  type ProviderResponse,
  removeProviderByName,
} from "../../providers/byok-providers";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

const SOLID_LINE = "─";

type ViewState =
  | { type: "list" }
  | { type: "input"; provider: ByokProvider }
  | { type: "multiInput"; provider: ByokProvider }
  | { type: "options"; provider: ByokProvider; providerId: string };

type ValidationState = "idle" | "validating" | "valid" | "invalid";

interface ProviderSelectorProps {
  onCancel: () => void;
  /** Called when ChatGPT/Codex OAuth flow should start */
  onStartOAuth?: () => void;
}

export function ProviderSelector({
  onCancel,
  onStartOAuth,
}: ProviderSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  // State
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [connectedProviders, setConnectedProviders] = useState<
    Map<string, ProviderResponse>
  >(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({ type: "list" });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [validationState, setValidationState] =
    useState<ValidationState>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [optionIndex, setOptionIndex] = useState(0);
  // Multi-field input state (for providers like Bedrock)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [focusedFieldIndex, setFocusedFieldIndex] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load connected providers on mount
  useEffect(() => {
    (async () => {
      try {
        const providers = await getConnectedProviders();
        if (mountedRef.current) {
          setConnectedProviders(providers);
          setIsLoading(false);
        }
      } catch {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, []);

  // Check if a provider is connected
  const isConnected = useCallback(
    (provider: ByokProvider) => {
      return connectedProviders.has(provider.providerName);
    },
    [connectedProviders],
  );

  // Get provider ID if connected
  const getProviderId = useCallback(
    (provider: ByokProvider): string | undefined => {
      return connectedProviders.get(provider.providerName)?.id;
    },
    [connectedProviders],
  );

  // Handle selecting a provider from the list
  const handleSelectProvider = useCallback(
    (provider: ByokProvider) => {
      if ("isOAuth" in provider && provider.isOAuth) {
        // OAuth provider - trigger OAuth flow
        if (onStartOAuth) {
          onStartOAuth();
        }
        return;
      }

      const connected = isConnected(provider);
      if (connected) {
        // Show options for connected provider
        const providerId = getProviderId(provider);
        if (providerId) {
          setViewState({ type: "options", provider, providerId });
          setOptionIndex(0);
        }
      } else if ("fields" in provider && provider.fields) {
        // Multi-field provider (like Bedrock) - show multi-input view
        setViewState({ type: "multiInput", provider });
        setFieldValues({});
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
    [isConnected, getProviderId, onStartOAuth],
  );

  // Handle API key validation and saving
  const handleValidateAndSave = useCallback(async () => {
    if (viewState.type !== "input") return;
    if (!apiKeyInput.trim()) return;

    const { provider } = viewState;

    // If already validated, save
    if (validationState === "valid") {
      try {
        await createOrUpdateProvider(
          provider.providerType,
          provider.providerName,
          apiKeyInput.trim(),
        );
        // Refresh connected providers
        const providers = await getConnectedProviders();
        if (mountedRef.current) {
          setConnectedProviders(providers);
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
      await checkProviderApiKey(provider.providerType, apiKeyInput.trim());
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
  }, [viewState, apiKeyInput, validationState]);

  // Handle multi-field validation and saving (for providers like Bedrock)
  const handleMultiFieldValidateAndSave = useCallback(async () => {
    if (viewState.type !== "multiInput") return;
    if (!("fields" in viewState.provider) || !viewState.provider.fields) return;

    const { provider } = viewState;
    const fields = provider.fields;

    // Check all required fields are filled
    const allFilled = fields.every((field) => fieldValues[field.key]?.trim());
    if (!allFilled) return;

    const apiKey = fieldValues.apiKey?.trim() || "";
    const accessKey = fieldValues.accessKey?.trim();
    const region = fieldValues.region?.trim();

    // If already validated, save
    if (validationState === "valid") {
      try {
        await createOrUpdateProvider(
          provider.providerType,
          provider.providerName,
          apiKey,
          accessKey,
          region,
        );
        // Refresh connected providers
        const providers = await getConnectedProviders();
        if (mountedRef.current) {
          setConnectedProviders(providers);
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
  }, [viewState, fieldValues, validationState]);

  // Handle disconnect
  const handleDisconnect = useCallback(async () => {
    if (viewState.type !== "options") return;

    const { provider } = viewState;
    try {
      await removeProviderByName(provider.providerName);
      // Refresh connected providers
      const providers = await getConnectedProviders();
      if (mountedRef.current) {
        setConnectedProviders(providers);
        setViewState({ type: "list" });
      }
    } catch {
      // Silently fail, stay on options view
    }
  }, [viewState]);

  // Handle update key option
  const handleUpdateKey = useCallback(() => {
    if (viewState.type !== "options") return;
    const { provider } = viewState;
    setViewState({ type: "input", provider });
    setApiKeyInput("");
    setValidationState("idle");
    setValidationError(null);
  }, [viewState]);

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
        onCancel();
      } else if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) =>
          Math.min(BYOK_PROVIDERS.length - 1, prev + 1),
        );
      } else if (key.return) {
        const provider = BYOK_PROVIDERS[selectedIndex];
        if (provider) {
          handleSelectProvider(provider);
        }
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
    } else if (viewState.type === "multiInput") {
      if (!("fields" in viewState.provider) || !viewState.provider.fields)
        return;
      const fields = viewState.provider.fields;
      const currentField = fields[focusedFieldIndex];
      if (!currentField) return;

      if (key.escape) {
        // Back to list
        setViewState({ type: "list" });
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
      const options = ["Update API key", "Disconnect", "Back"];
      if (key.escape) {
        setViewState({ type: "list" });
      } else if (key.upArrow) {
        setOptionIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setOptionIndex((prev) => Math.min(options.length - 1, prev + 1));
      } else if (key.return) {
        if (optionIndex === 0) {
          handleUpdateKey();
        } else if (optionIndex === 1) {
          handleDisconnect();
        } else {
          setViewState({ type: "list" });
        }
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
      </Box>

      {isLoading ? (
        <Box>
          <Text dimColor>{"  "}Loading providers...</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {BYOK_PROVIDERS.map((provider, index) => {
            const isSelected = index === selectedIndex;
            const connected = isConnected(provider);

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
                    <Text color="green">Connected</Text>
                  ) : (
                    provider.description
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {!isLoading && (
        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc cancel</Text>
        </Box>
      )}
    </>
  );

  // Render input view
  const renderInputView = () => {
    if (viewState.type !== "input") return null;
    const { provider } = viewState;

    const statusText =
      validationState === "validating"
        ? " (validating...)"
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
      validationState === "valid"
        ? "Enter to save · Esc cancel"
        : "Enter to validate · Esc cancel";

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {"  "}Connect your {provider.displayName} key:
          </Text>
        </Box>

        <Box flexDirection="row">
          <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
          <Text>{apiKeyInput ? maskApiKey(apiKeyInput) : "(enter key)"}</Text>
          <Text color={statusColor} dimColor={validationState === "validating"}>
            {statusText}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {"  "}
            {footerText}
          </Text>
        </Box>
      </>
    );
  };

  // Render multi-input view (for providers like Bedrock)
  const renderMultiInputView = () => {
    if (viewState.type !== "multiInput") return null;
    if (!("fields" in viewState.provider) || !viewState.provider.fields)
      return null;

    const { provider } = viewState;
    const fields = provider.fields;

    // Check if all fields are filled
    const allFilled = fields.every((field) => fieldValues[field.key]?.trim());

    const statusText =
      validationState === "validating"
        ? " (validating...)"
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

    const footerText =
      validationState === "valid"
        ? "Enter to save · Esc cancel"
        : allFilled
          ? "Enter to validate · Tab/↑↓ navigate · Esc cancel"
          : "Tab/↑↓ navigate · Esc cancel";

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
        </Box>

        <Box flexDirection="column">
          {fields.map((field, index) => {
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
                  {field.label}:
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
              dimColor={validationState === "validating"}
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
    const options = ["Update API key", "Disconnect", "Back"];

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            <Text>{"  "}</Text>
            <Text color="green">[✓]</Text>
            <Text> </Text>
            <Text bold>{provider.displayName}</Text>
            <Text dimColor> · </Text>
            <Text color="green">Connected</Text>
          </Box>
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
          <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc back</Text>
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
      {viewState.type === "multiInput" && renderMultiInputView()}
      {viewState.type === "options" && renderOptionsView()}
    </Box>
  );
}
