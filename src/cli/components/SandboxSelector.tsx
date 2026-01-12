import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
  disableSandbox,
  enableSandbox,
  getApiKeyFromEnv,
  hasApiKeyInEnv,
  type SandboxProvider,
  type SandboxStatus,
} from "../../sandbox";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

type SandboxOption = "e2b" | "daytona" | "disable";

interface SandboxSelectorProps {
  agentId: string;
  initialStatus?: SandboxStatus;
  onComplete: (message: string) => void;
  onCancel: () => void;
}

export function SandboxSelector({
  agentId,
  initialStatus,
  onComplete,
  onCancel,
}: SandboxSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [phase, setPhase] = useState<"select" | "input" | "loading">("select");
  const [selectedProvider, setSelectedProvider] =
    useState<SandboxProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState("");

  // Check which providers have API keys in env
  const e2bHasKey = hasApiKeyInEnv("e2b");
  const daytonaHasKey = hasApiKeyInEnv("daytona");

  const options: Array<{
    id: SandboxOption;
    label: string;
    description: string;
    hasKey?: boolean;
  }> = [
    {
      id: "e2b",
      label: "E2B",
      description: "Cloud sandbox (https://e2b.dev)",
      hasKey: e2bHasKey,
    },
    {
      id: "daytona",
      label: "Daytona",
      description: "Cloud sandbox (https://daytona.io)",
      hasKey: daytonaHasKey,
    },
  ];

  // Add disable option if sandbox is currently enabled
  if (initialStatus?.enabled) {
    options.push({
      id: "disable",
      label: "Disable",
      description: `Remove ${initialStatus.provider?.toUpperCase() || "sandbox"} tools`,
    });
  }

  const handleSelect = async (option: SandboxOption) => {
    if (option === "disable") {
      setPhase("loading");
      setLoadingMessage("Disabling sandbox...");
      try {
        const removed = await disableSandbox(agentId);
        onComplete(`Sandbox disabled (${removed} tools removed)`);
      } catch (err) {
        setError(`Failed to disable sandbox: ${err}`);
        setPhase("select");
      }
      return;
    }

    const provider = option as SandboxProvider;

    // Check if API key is in env
    const envKey = getApiKeyFromEnv(provider);
    if (envKey) {
      // Use env key directly
      await enableWithKey(provider, envKey);
    } else {
      // Need to prompt for API key
      setSelectedProvider(provider);
      setPhase("input");
    }
  };

  const enableWithKey = async (provider: SandboxProvider, key: string) => {
    setPhase("loading");
    setLoadingMessage(`Enabling ${provider.toUpperCase()} sandbox...`);
    try {
      const toolCount = await enableSandbox(agentId, provider, key);
      onComplete(
        `Sandbox enabled: ${provider.toUpperCase()} (${toolCount} tools attached)`,
      );
    } catch (err) {
      setError(`Failed to enable sandbox: ${err}`);
      setPhase("select");
    }
  };

  const handleApiKeySubmit = async () => {
    if (!apiKey.trim()) {
      setError("API key cannot be empty");
      return;
    }
    if (!selectedProvider) return;
    await enableWithKey(selectedProvider, apiKey.trim());
  };

  useInput(
    (input, key) => {
      // CTRL-C: immediately cancel
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      if (phase === "select") {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) => Math.min(options.length - 1, prev + 1));
        } else if (key.return) {
          const selected = options[selectedIndex];
          if (selected) {
            handleSelect(selected.id);
          }
        } else if (key.escape) {
          onCancel();
        }
      } else if (phase === "input") {
        if (key.escape) {
          setPhase("select");
          setApiKey("");
          setError(null);
        } else if (key.return) {
          handleApiKeySubmit();
        }
      }
    },
    { isActive: phase !== "loading" },
  );

  // Loading state
  if (phase === "loading") {
    return (
      <Box flexDirection="column">
        <Text color={colors.status.processing}>{loadingMessage}</Text>
      </Box>
    );
  }

  // API key input phase
  if (phase === "input" && selectedProvider) {
    const providerName = selectedProvider.toUpperCase();
    const getKeyUrl =
      selectedProvider === "e2b" ? "https://e2b.dev" : "https://daytona.io";

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color={colors.selector.title}>
          {providerName} API Key
        </Text>

        {error && <Text color={colors.status.error}>{error}</Text>}

        <Box flexDirection="row" gap={1}>
          <Text>API Key:</Text>
          <PasteAwareTextInput
            value={apiKey}
            onChange={setApiKey}
            placeholder="Enter your API key..."
          />
        </Box>

        <Text dimColor>Get an API key at: {getKeyUrl}</Text>

        <Text dimColor>Enter to submit, ESC to go back</Text>
      </Box>
    );
  }

  // Provider selection phase
  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Select Sandbox Provider (↑↓ to navigate, Enter to select, ESC to
          cancel)
        </Text>
      </Box>

      {error && <Text color={colors.status.error}>{error}</Text>}

      <Box flexDirection="column">
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent =
            initialStatus?.enabled && initialStatus.provider === option.id;

          return (
            <Box key={option.id} flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? ">" : " "}
              </Text>
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text
                    bold={isSelected}
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {option.label}
                  </Text>
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}>(current)</Text>
                  )}
                  {option.hasKey !== undefined && (
                    <Text
                      color={option.hasKey ? colors.status.success : undefined}
                      dimColor={!option.hasKey}
                    >
                      {option.hasKey ? "(env key found)" : "(no env key)"}
                    </Text>
                  )}
                </Box>
                <Text dimColor> {option.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
