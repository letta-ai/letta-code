/**
 * Ink UI components for OAuth setup flow
 */

import { Box, useApp, useInput } from "ink";
import { useState } from "react";
import { configureBackendMode } from "@/backend";
import { AnimatedLogo } from "@/cli/components/AnimatedLogo";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { settingsManager } from "@/settings-manager";
import { ConstellationLoginView } from "./ConstellationLoginView";

type SetupMode = "menu" | "device-code" | "auth-code" | "self-host" | "done";

const AUTH_LOGIN_LABEL = "Login to Constellation";
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
            // Login to Constellation - start device code flow
            setMode("device-code");
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

  const proceedLocally = async () => {
    try {
      configureBackendMode("local");
      settingsManager.updateSettings({ preferredBackendMode: "local" });
      await settingsManager.flush();
      setDoneMessage(
        "Local mode enabled. Agents you create now will be stored on this device. To sign into Letta Cloud later, run `letta setup` or `letta backend api`.",
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
        <ConstellationLoginView
          onComplete={onComplete}
          onAlreadyLoggedIn={onComplete}
        />
      </Box>
    );
  }

  // Main menu
  return (
    <Box flexDirection="column" padding={1}>
      <AnimatedLogo color={colors.welcome.accent} animate={AUTH_LOGO_ANIMATE} />
      <Text> </Text>
      <Text bold>Welcome to Letta Code</Text>
      <Text dimColor>
        Sign in to Constellation for remote access via chat.letta.com and other
        devices, or continue locally with agent state stored on this device.
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
