/**
 * Ink UI components for OAuth setup flow
 */

import { hostname } from "node:os";
import { Box, useApp, useInput } from "ink";
import { useState } from "react";
import { configureBackendMode } from "../backend";
import { AnimatedLogo } from "../cli/components/AnimatedLogo";
import { colors } from "../cli/components/colors";
import { Text } from "../cli/components/Text";
import { settingsManager } from "../settings-manager";
import { pollForToken, requestDeviceCode } from "./oauth";

type SetupMode = "menu" | "device-code" | "auth-code" | "self-host" | "done";

const AUTH_LOGIN_LABEL = "Login to Letta Constellation";
const LOCAL_MODE_LABEL = "Proceed locally";
const AUTH_LOGO_ANIMATE = false;

interface SetupUIProps {
  onComplete: () => void;
}

export function SetupUI({ onComplete }: SetupUIProps) {
  const [mode, setMode] = useState<SetupMode>("menu");
  const [selectedOption, setSelectedOption] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState("Starting Letta Code...");
  const [_deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);

  const { exit } = useApp();

  // Handle menu navigation
  useInput(
    (_input, key) => {
      if (mode === "menu") {
        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedOption((prev) => Math.min(2, prev + 1));
        } else if (key.return) {
          if (selectedOption === 0) {
            // Login to Letta Constellation - start device code flow
            setMode("device-code");
            startDeviceCodeFlow();
          } else if (selectedOption === 1) {
            proceedLocally();
          } else if (selectedOption === 2) {
            exit();
          }
        }
      }
    },
    { isActive: mode === "menu" },
  );

  const startDeviceCodeFlow = async () => {
    try {
      const deviceData = await requestDeviceCode();
      setDeviceCode(deviceData.device_code);
      setUserCode(deviceData.user_code);
      setVerificationUri(deviceData.verification_uri_complete);

      // Auto-open browser (fire-and-forget, never crash)
      // Uses promise chaining to ensure error handler is attached immediately
      // after promise resolution, preventing race conditions with error events
      import("open")
        .then(({ default: open }) =>
          open(deviceData.verification_uri_complete, { wait: false }),
        )
        .then((subprocess) => {
          subprocess.on("error", () => {
            // Silently ignore - user can manually visit the URL shown above
          });
        })
        .catch(() => {
          // Silently ignore any failures (WSL PowerShell issues, missing xdg-open, etc.)
        });

      // Get or generate device ID
      const deviceId = settingsManager.getOrCreateDeviceId();
      const deviceName = hostname();

      // Start polling in background
      pollForToken(
        deviceData.device_code,
        deviceData.interval,
        deviceData.expires_in,
        deviceId,
        deviceName,
      )
        .then(async (tokens) => {
          // Save tokens using secrets for secure storage
          // Note: LETTA_BASE_URL is intentionally NOT saved to settings
          // It should only come from environment variables
          const now = Date.now();

          try {
            // Update settings with non-sensitive data and tokens (secrets handles secure storage)
            settingsManager.updateSettings({
              env: {
                ...settingsManager.getSettings().env,
                LETTA_API_KEY: tokens.access_token,
              },
              refreshToken: tokens.refresh_token,
              tokenExpiresAt: now + tokens.expires_in * 1000,
              preferredBackendMode: "api",
            });

            // Wait for all pending writes (keychain, disk) to complete before continuing
            // This prevents a race condition where main() validation runs before tokens are persisted
            await settingsManager.flush();

            setMode("done");
            setTimeout(() => onComplete(), 1000);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .catch((err) => {
          setError(err.message);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const proceedLocally = async () => {
    try {
      configureBackendMode("local");
      settingsManager.updateSettings({ preferredBackendMode: "local" });
      await settingsManager.flush();
      setDoneMessage(
        "Local mode enabled. Agents you create now will be stored on this device.",
      );
      setMode("done");
      setTimeout(() => onComplete(), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (mode === "done") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">✓ Setup complete!</Text>
        <Text dimColor>{doneMessage}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">✗ Error: {error}</Text>
        <Text dimColor>Press Ctrl+C to exit</Text>
      </Box>
    );
  }

  if (mode === "device-code") {
    return (
      <Box flexDirection="column" padding={1}>
        <AnimatedLogo
          color={colors.welcome.accent}
          animate={AUTH_LOGO_ANIMATE}
        />
        <Text> </Text>
        <Text bold>{AUTH_LOGIN_LABEL}</Text>
        <Text> </Text>
        <Text dimColor>Opening browser for authorization...</Text>
        <Text> </Text>
        <Text>
          Your authorization code:{" "}
          <Text color="yellow" bold>
            {userCode}
          </Text>
        </Text>
        <Text dimColor>If browser didn't open, visit: {verificationUri}</Text>
        <Text> </Text>
        <Text dimColor>Waiting for you to authorize in the browser...</Text>
      </Box>
    );
  }

  // Main menu
  return (
    <Box flexDirection="column" padding={1}>
      <AnimatedLogo color={colors.welcome.accent} animate={AUTH_LOGO_ANIMATE} />
      <Text> </Text>
      <Text bold>Welcome to Letta Code.</Text>
      <Text dimColor>
        Sign in to Letta Constellation for remote access via chat.letta.com and
        other devices, or continue locally with agent state stored on this
        device.
      </Text>
      <Text> </Text>
      <Box>
        <Text
          color={
            selectedOption === 0 ? colors.selector.itemHighlighted : undefined
          }
        >
          {selectedOption === 0 ? "> " : "  "}
          {AUTH_LOGIN_LABEL}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>
          Access hosted agents remotely from chat.letta.com and connected
          devices.
        </Text>
      </Box>
      <Box>
        <Text
          color={
            selectedOption === 1 ? colors.selector.itemHighlighted : undefined
          }
        >
          {selectedOption === 1 ? "> " : "  "}
          {LOCAL_MODE_LABEL} (default)
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>
          Store agent state on this device. Agents you create are local to this
          machine.
        </Text>
      </Box>
      <Box>
        <Text
          color={
            selectedOption === 2 ? colors.selector.itemHighlighted : undefined
          }
        >
          {selectedOption === 2 ? "> " : "  "}Exit
        </Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Use ↑/↓ to navigate, Enter to select</Text>
    </Box>
  );
}
