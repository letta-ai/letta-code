import { Box, Text, useInput } from "ink";
import { memo, useEffect, useState } from "react";
import {
  exchangeCodeForTokens,
  startAnthropicOAuth,
  validateAnthropicCredentials,
} from "../../auth/anthropic-oauth";
import {
  ANTHROPIC_PROVIDER_NAME,
  checkAnthropicOAuthEligibility,
  createOrUpdateAnthropicProvider,
} from "../../providers/anthropic-provider";
import { settingsManager } from "../../settings-manager";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

type Props = {
  onComplete: (success: boolean, message: string) => void;
  onCancel: () => void;
  onModelSwitch?: (modelHandle: string) => Promise<void>;
};

type FlowState =
  | "initializing"
  | "checking_eligibility"
  | "waiting_for_code"
  | "exchanging"
  | "validating"
  | "creating_provider"
  | "fetching_models"
  | "select_model"
  | "switching_model"
  | "success"
  | "error";

export const OAuthCodeDialog = memo(
  ({ onComplete, onCancel, onModelSwitch }: Props) => {
    const [flowState, setFlowState] = useState<FlowState>("initializing");
    const [authUrl, setAuthUrl] = useState<string>("");
    const [codeInput, setCodeInput] = useState("");
    const [errorMessage, setErrorMessage] = useState<string>("");
    const [codeVerifier, setCodeVerifier] = useState<string>("");
    const [state, setState] = useState<string>("");
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [selectedModelIndex, setSelectedModelIndex] = useState(0);

    // Initialize OAuth flow on mount
    useEffect(() => {
      const initFlow = async () => {
        try {
          // Check if already connected
          if (
            settingsManager.hasAnthropicOAuth() &&
            !settingsManager.isAnthropicTokenExpired()
          ) {
            onComplete(
              false,
              "Already connected to Claude via OAuth.\n\nUse /disconnect to remove the current connection first.",
            );
            return;
          }

          // Check eligibility before starting OAuth flow
          setFlowState("checking_eligibility");
          const eligibility = await checkAnthropicOAuthEligibility();
          if (!eligibility.eligible) {
            onComplete(
              false,
              `✗ Claude OAuth requires a Pro or Enterprise plan\n\n` +
                `This feature is only available for Letta Pro or Enterprise customers.\n` +
                `Current plan: ${eligibility.billing_tier}\n\n` +
                `To upgrade your plan, visit:\n\n` +
                `  https://app.letta.com/settings/organization/usage\n\n` +
                `If you have an Anthropic API key, you can use it directly by setting:\n` +
                `  export ANTHROPIC_API_KEY=your-key`,
            );
            return;
          }

          // Start OAuth flow
          const {
            authorizationUrl,
            state: oauthState,
            codeVerifier: verifier,
          } = await startAnthropicOAuth();

          // Store state for validation
          settingsManager.storeOAuthState(oauthState, verifier, "anthropic");

          setAuthUrl(authorizationUrl);
          setCodeVerifier(verifier);
          setState(oauthState);
          setFlowState("waiting_for_code");

          // Try to open browser
          try {
            const { default: open } = await import("open");
            const subprocess = await open(authorizationUrl, { wait: false });
            subprocess.on("error", () => {
              // Silently ignore - user can manually visit URL
            });
          } catch {
            // If auto-open fails, user can still manually visit the URL
          }
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
          setFlowState("error");
        }
      };

      initFlow();
    }, [onComplete]);

    // Handle keyboard input
    useInput((input, key) => {
      // CTRL-C: cancel at any cancelable state
      if (key.ctrl && input === "c") {
        if (flowState === "waiting_for_code" || flowState === "select_model") {
          settingsManager.clearOAuthState();
          onCancel();
        }
        return;
      }

      if (key.escape && flowState === "waiting_for_code") {
        settingsManager.clearOAuthState();
        onCancel();
      }

      // Handle model selection navigation
      if (flowState === "select_model") {
        if (key.upArrow) {
          setSelectedModelIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedModelIndex((prev) =>
            Math.min(availableModels.length - 1, prev + 1),
          );
        } else if (key.return && onModelSwitch) {
          // Select current model
          const selectedModel = availableModels[selectedModelIndex];
          if (selectedModel) {
            handleModelSelection(selectedModel);
          }
        } else if (key.escape) {
          // Skip model selection
          skipModelSelection();
        }
      }
    });

    // Handle model selection
    const handleModelSelection = async (modelHandle: string) => {
      if (!onModelSwitch) return;

      setFlowState("switching_model");
      try {
        await onModelSwitch(modelHandle);
        setFlowState("success");
        onComplete(
          true,
          `✓ Successfully connected to Claude via OAuth!\n\n` +
            `Provider '${ANTHROPIC_PROVIDER_NAME}' created/updated in Letta.\n` +
            `Switched to model: ${modelHandle.replace(`${ANTHROPIC_PROVIDER_NAME}/`, "")}`,
        );
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setFlowState("error");
      }
    };

    // Skip model selection
    const skipModelSelection = () => {
      setFlowState("success");
      onComplete(
        true,
        `✓ Successfully connected to Claude via OAuth!\n\n` +
          `Provider '${ANTHROPIC_PROVIDER_NAME}' created/updated in Letta.\n` +
          `Your OAuth tokens are stored securely in ~/.letta/settings.json\n` +
          `Use /model to switch to a Claude model.`,
      );
    };

    // Handle code submission
    const handleSubmit = async (input: string) => {
      if (!input.trim()) return;

      try {
        setFlowState("exchanging");

        // Parse code#state format
        let authCode = input.trim();
        let stateFromInput: string | undefined;

        if (authCode.includes("#")) {
          const [code, inputState] = authCode.split("#");
          authCode = code ?? input.trim();
          stateFromInput = inputState;

          // Validate state matches
          if (stateFromInput && stateFromInput !== state) {
            throw new Error(
              "State mismatch - the authorization may have been tampered with. Please try again.",
            );
          }
        }

        const stateToUse = stateFromInput || state;

        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(
          authCode,
          codeVerifier,
          stateToUse,
        );

        setFlowState("validating");

        // Validate tokens
        const isValid = await validateAnthropicCredentials(tokens.access_token);
        if (!isValid) {
          throw new Error(
            "Token validation failed - the token may not have the required permissions.",
          );
        }

        // Store tokens locally
        settingsManager.storeAnthropicTokens(tokens);

        setFlowState("creating_provider");

        // Create/update provider in Letta
        await createOrUpdateAnthropicProvider(tokens.access_token);

        // Clear OAuth state
        settingsManager.clearOAuthState();

        // If we have a model switch handler, try to fetch available models
        if (onModelSwitch) {
          setFlowState("fetching_models");
          try {
            const { getAvailableModelHandles } = await import(
              "../../agent/available-models"
            );
            const result = await getAvailableModelHandles({
              forceRefresh: true,
            });

            // Filter to only claude-pro-max models
            const claudeModels = Array.from(result.handles)
              .filter((h) => h.startsWith(`${ANTHROPIC_PROVIDER_NAME}/`))
              .sort();

            if (claudeModels.length > 0) {
              setAvailableModels(claudeModels);
              setFlowState("select_model");
              return; // Don't complete yet, wait for model selection
            }
          } catch {
            // If fetching models fails, just complete without selection
          }
        }

        setFlowState("success");
        onComplete(
          true,
          `✓ Successfully connected to Claude via OAuth!\n\n` +
            `Provider '${ANTHROPIC_PROVIDER_NAME}' created/updated in Letta.\n` +
            `Your OAuth tokens are stored securely in ~/.letta/settings.json\n` +
            `Use /model to switch to a Claude model.`,
        );
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setFlowState("error");
      }
    };

    if (flowState === "initializing" || flowState === "checking_eligibility") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color={colors.status.processing}>
            {flowState === "checking_eligibility"
              ? "Checking account eligibility..."
              : "Starting Claude OAuth flow..."}
          </Text>
        </Box>
      );
    }

    if (flowState === "error") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red">✗ OAuth Error: {errorMessage}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press any key to close</Text>
          </Box>
          <WaitForKeyThenClose
            onClose={() => {
              settingsManager.clearOAuthState();
              onComplete(false, `✗ Failed to connect: ${errorMessage}`);
            }}
          />
        </Box>
      );
    }

    // Model selection UI
    if (flowState === "select_model") {
      return (
        <Box flexDirection="column" padding={1}>
          <Box marginBottom={1}>
            <Text color={colors.approval.header} bold>
              [Claude OAuth]
            </Text>
            <Text color="green"> Connected!</Text>
          </Box>

          <Box marginBottom={1}>
            <Text>Select a model to switch to:</Text>
          </Box>

          <Box flexDirection="column" marginBottom={1}>
            {availableModels.map((model, index) => {
              const displayName = model.replace(
                `${ANTHROPIC_PROVIDER_NAME}/`,
                "",
              );
              const isSelected = index === selectedModelIndex;
              return (
                <Box key={model}>
                  <Text color={isSelected ? colors.approval.header : undefined}>
                    {isSelected ? "› " : "  "}
                    {displayName}
                  </Text>
                </Box>
              );
            })}
          </Box>

          <Box marginTop={1}>
            <Text dimColor>↑↓ to select, Enter to confirm, Esc to skip</Text>
          </Box>
        </Box>
      );
    }

    if (flowState !== "waiting_for_code") {
      const statusMessages: Record<string, string> = {
        exchanging: "Exchanging authorization code for tokens...",
        validating: "Validating credentials...",
        creating_provider: "Creating Claude provider...",
        fetching_models: "Fetching available models...",
        switching_model: "Switching model...",
        success: "Success!",
      };

      return (
        <Box flexDirection="column" padding={1}>
          <Text color={colors.status.processing}>
            {statusMessages[flowState]}
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text color={colors.approval.header} bold>
            [Claude OAuth]
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text>Opening browser for authorization...</Text>
        </Box>

        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>If browser doesn't open, copy this URL:</Text>
          <Text color={colors.link.url}>{authUrl}</Text>
        </Box>

        <Box marginBottom={1} flexDirection="column">
          <Text>
            After authorizing, copy the <Text bold>code</Text> value from the
            page and paste it below:
          </Text>
        </Box>

        <Box>
          <Text color={colors.approval.header}>&gt; </Text>
          <PasteAwareTextInput
            value={codeInput}
            onChange={setCodeInput}
            onSubmit={handleSubmit}
            placeholder="Paste code here..."
          />
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Enter to submit, Esc to cancel</Text>
        </Box>
      </Box>
    );
  },
);

OAuthCodeDialog.displayName = "OAuthCodeDialog";

// Helper component to wait for any key press then close
const WaitForKeyThenClose = memo(({ onClose }: { onClose: () => void }) => {
  useInput(() => {
    onClose();
  });
  return null;
});

WaitForKeyThenClose.displayName = "WaitForKeyThenClose";
