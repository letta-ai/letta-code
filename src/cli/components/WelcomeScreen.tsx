import { homedir } from "node:os";
import type { Letta } from "@letta-ai/letta-client";
import { Box } from "ink";
import { useEffect, useState } from "react";
import { getModelDisplayName } from "@/agent/model";
import { isLocalBackendEnabled } from "@/backend";
import { getStartupModelDisplayOverride } from "@/cli/helpers/startup-model-display";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version";
import { AnimatedLogo } from "./AnimatedLogo";
import { colors } from "./colors";
import { Text } from "./Text";

function toTildePath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath.startsWith(home)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}

function getInitialAuthMethod(): "local" | "url" | "api-key" | null {
  if (isLocalBackendEnabled()) return "local";
  if (process.env.LETTA_BASE_URL) return "url";
  if (process.env.LETTA_API_KEY) return "api-key";
  return null;
}

async function getAuthMethod(): Promise<"local" | "url" | "api-key" | "oauth"> {
  if (isLocalBackendEnabled()) return "local";
  if (process.env.LETTA_BASE_URL) {
    return "url";
  }
  if (process.env.LETTA_API_KEY) {
    return "api-key";
  }
  const settings = await settingsManager.getSettingsWithSecureTokens();
  if (settings.refreshToken) {
    return "oauth";
  }
  if (settings.env?.LETTA_API_KEY) {
    return "api-key";
  }
  return "oauth";
}

type LoadingState =
  | "loading_profiles"
  | "assembling"
  | "initializing"
  | "checking"
  | "selecting_global"
  | "ready";

function StartupWelcome({
  loadingState,
  continueSession,
  agentState,
  startupHasAvailableLocalModels = true,
}: {
  loadingState: LoadingState;
  continueSession?: boolean;
  agentState?: Letta.AgentState | null;
  startupHasAvailableLocalModels?: boolean;
}) {
  useTerminalWidth();
  const cwd = process.cwd();

  const tildePath = toTildePath(cwd);

  const llmConfig = agentState?.llm_config;
  const fullModel =
    llmConfig?.model_endpoint_type && llmConfig?.model
      ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
      : (llmConfig?.model ?? null);
  const startupModelDisplayOverride = getStartupModelDisplayOverride({
    isLocalBackend: isLocalBackendEnabled(),
    startupHasAvailableLocalModels,
  });
  const model =
    startupModelDisplayOverride ??
    (fullModel
      ? (getModelDisplayName(fullModel) ?? fullModel.split("/").pop())
      : undefined);

  const initialAuth = getInitialAuthMethod();
  const [authMethod, setAuthMethod] = useState<
    "local" | "url" | "api-key" | "oauth"
  >(initialAuth ?? "oauth");

  useEffect(() => {
    if (!initialAuth) {
      getAuthMethod().then(setAuthMethod);
    }
  }, [initialAuth]);
  const authDisplay =
    authMethod === "local"
      ? "Local"
      : authMethod === "url"
        ? process.env.LETTA_BASE_URL || "Custom URL"
        : "Cloud";

  const memfsEnabled = agentState?.id
    ? settingsManager.isMemfsEnabled(agentState.id)
    : true;

  return (
    <SessionWelcome
      loadingState={loadingState}
      model={model}
      location={tildePath}
      connection={authDisplay}
      continueSession={continueSession}
      warning={
        loadingState === "ready" &&
        !memfsEnabled &&
        authMethod !== "url" && (
          <Text color="yellow">
            Warning: Context repositories are not enabled for this agent. Run
            /memfs enable to enable.
          </Text>
        )
      }
    />
  );
}

export function WelcomeScreen(
  props: Parameters<typeof StartupWelcome>[0] & {
    session?: { model?: string; location?: string; connection: string };
  },
) {
  return props.session ? (
    <SessionWelcome loadingState={props.loadingState} {...props.session} />
  ) : (
    <StartupWelcome {...props} />
  );
}

function SessionWelcome({
  loadingState,
  model,
  location,
  connection,
  continueSession,
  warning,
}: {
  loadingState: LoadingState;
  model?: string;
  location?: string;
  connection: string;
  continueSession?: boolean;
  warning?: React.ReactNode;
}) {
  const version = getVersion();
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexDirection="column" paddingLeft={1} paddingRight={2}>
        <AnimatedLogo
          color={colors.welcome.accent}
          animate={loadingState !== "ready"}
        />
      </Box>

      <Box flexDirection="column" marginTop={0}>
        <Box>
          <Text bold>Letta Code</Text>
          <Text color="gray"> v{version}</Text>
        </Box>

        <Text color="gray">
          {model ? `${model} · ${connection}` : connection}
        </Text>

        <Text color="gray">
          {loadingState === "ready"
            ? location
            : getLoadingMessage(loadingState, !!continueSession)}
        </Text>

        {warning}
      </Box>
    </Box>
  );
}

function getLoadingMessage(
  loadingState: LoadingState,
  continueSession: boolean,
): string {
  switch (loadingState) {
    case "loading_profiles":
      return "Loading pinned agents...";
    case "initializing":
      return continueSession ? "Resuming agent..." : "Creating agent...";
    case "assembling":
      return "Assembling tools...";
    case "checking":
      return "Checking for pending approvals...";
    default:
      return "Loading...";
  }
}
