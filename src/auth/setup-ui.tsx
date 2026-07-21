/**
 * Ink UI components for OAuth setup flow
 */

import { Box, useInput } from "ink";
import { useState } from "react";
import { configureBackendMode } from "@/backend";
import { AnimatedLogo } from "@/cli/components/AnimatedLogo";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { settingsManager } from "@/settings-manager";
import { LettaLoginView } from "./LettaLoginView";

type SetupMode = "menu" | "device-code" | "auth-code" | "self-host" | "done";
export type SetupInitialMode = "menu" | "device-code";
export type SetupResult =
  | { kind: "cloud-login" }
  | { kind: "local" }
  | { kind: "cancelled" };

const AUTH_LOGIN_LABEL = "Sign in with Letta";
const LOCAL_MODE_LABEL = "Proceed locally";
const AUTH_LOGO_ANIMATE = false;

interface SetupUIProps {
  onComplete: (result: SetupResult) => void;
  onCancel: () => void;
  initialMode?: SetupInitialMode;
  localModeDisabledReason?: string;
}

export function SetupUI({
  onComplete,
  onCancel,
  initialMode = "menu",
  localModeDisabledReason,
}: SetupUIProps) {
  const localModeDisabled = Boolean(localModeDisabledReason);
  const [mode, setMode] = useState<SetupMode>(initialMode);
  const [selectedOption, setSelectedOption] = useState(
    initialMode === "device-code" || localModeDisabled ? 0 : 1,
  );
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState("Starting Letta Code...");
  const selectNextOption = (current: number, delta: 1 | -1): number => {
    const options = localModeDisabled ? [0, 2] : [0, 1, 2];
    const currentIndex = options.indexOf(current);
    const nextIndex = Math.min(
      options.length - 1,
      Math.max(0, currentIndex + delta),
    );
    return options[nextIndex] ?? current;
  };

  // Handle menu navigation
  useInput(
    (_input, key) => {
      if (mode === "menu") {
        if (key.upArrow) {
          setSelectedOption((prev) => selectNextOption(prev, -1));
        } else if (key.downArrow) {
          setSelectedOption((prev) => selectNextOption(prev, 1));
        } else if (key.return) {
          if (selectedOption === 0) {
            // Sign in with Letta - start device code flow
            setMode("device-code");
          } else if (selectedOption === 1 && !localModeDisabled) {
            proceedLocally();
          } else if (selectedOption === 2) {
            onCancel();
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
        "Local mode enabled. Agents you create now will be stored on this device. To sign into Letta Cloud later, run `letta setup` or `letta backend cloud`.",
      );
      setMode("done");
      setTimeout(() => onComplete({ kind: "local" }), 500);
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
        <LettaLoginView
          onComplete={() => onComplete({ kind: "cloud-login" })}
          onCancel={() => setMode("menu")}
          successMessage="Signed in with Letta. Starting Letta Code..."
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
        Sign in with Letta for remote access via chat.letta.com and other
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
            selectedOption === 1 && !localModeDisabled
              ? colors.selector.itemHighlighted
              : undefined
          }
          dimColor={localModeDisabled}
        >
          {selectedOption === 1 ? "> " : "  "}
          {LOCAL_MODE_LABEL} {localModeDisabled ? "(unavailable)" : "(default)"}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        {localModeDisabledReason ? (
          <Text dimColor>{localModeDisabledReason}</Text>
        ) : (
          <Text dimColor>
            Store agent state on this device. Agents you create are local to
            this machine.
          </Text>
        )}
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
