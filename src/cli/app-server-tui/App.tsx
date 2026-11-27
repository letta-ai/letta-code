import { Box } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackend } from "@/backend";
import { getAgentContextOverview } from "@/backend/api/agents";
import { getBalanceMetadata } from "@/backend/api/metadata";
import type { AppProps } from "@/cli/app/types";
import { Text } from "@/cli/components/Text";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { renderContextUsage } from "@/cli/helpers/context-chart";
import type { CommandContext, SessionTarget } from "./command-router";
import {
  readSessionHostOptions,
  type SessionHost,
  startSessionHost,
} from "./session-host";
import type { TuiSessionStore } from "./session-store";
import { TuiRoot } from "./TuiRoot";

let sharedHost: Promise<SessionHost> | null = null;

function getSharedHost(): Promise<SessionHost> {
  sharedHost ??= startSessionHost(readSessionHostOptions(process.argv));
  return sharedHost;
}

const HOST_LABELS: Record<SessionHost["mode"], string> = {
  embedded: "",
  registered: "registered computer",
  attached: "attached app server",
};

interface ActiveSession {
  target: SessionTarget;
  store: TuiSessionStore;
  hostLabel: string;
}

async function logout(): Promise<string> {
  const { settingsManager } = await import("@/settings-manager");
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const hasEnvApiKey = Boolean(process.env.LETTA_API_KEY);
  if (!hasEnvApiKey && !settings.refreshToken && !settings.env?.LETTA_API_KEY) {
    return "Already logged out. Run /login to sign in with Letta.";
  }
  if (settings.refreshToken) {
    const { revokeToken } = await import("@/auth/oauth");
    await revokeToken(settings.refreshToken);
  }
  (await import("@/agent/organization-id")).clearOrganizationId();
  await settingsManager.logout();
  return hasEnvApiKey
    ? "Logged out. LETTA_API_KEY is still set in this shell and will be used on the next start."
    : "Logged out. Restart and run /login to sign in again.";
}

function SessionApp({
  initial,
  initialAgentName,
}: {
  initial: SessionTarget;
  initialAgentName: string | null;
}) {
  const [target, setTarget] = useState(initial);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [agentName, setAgentName] = useState(initialAgentName);
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    let store: TuiSessionStore | null = null;
    setActive(null);
    getSharedHost()
      .then(async (host) => {
        if (cancelled) return;
        store = host.open(target.agentId, target.conversationId);
        const opened = store;
        setActive({ target, store: opened, hostLabel: HOST_LABELS[host.mode] });
        await opened.start();
        if (cancelled) return;
        const response = await opened
          .request<{ agent: { name?: string | null } | null }>(
            { type: "agent_retrieve", agent_id: target.agentId },
            "agent_retrieve_response",
            { scoped: false },
          )
          .catch(() => null);
        if (!cancelled && response?.agent?.name) {
          setAgentName(response.agent.name);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      store?.close();
    };
  }, [target]);

  const services = useMemo<
    Pick<CommandContext, "logout" | "usage" | "context">
  >(
    () => ({
      logout,
      usage: async () => {
        const wallSeconds = Math.round(
          (Date.now() - startedAtRef.current) / 1000,
        );
        const lines = [`Session duration: ${wallSeconds}s`];
        const balance = await getBalanceMetadata().catch(() => null);
        if (balance) {
          lines.push(
            `Plan: ${balance.billing_tier}`,
            `Credits: ${Math.round(balance.total_balance)} (${Math.round(balance.monthly_credit_balance)} monthly, ${Math.round(balance.purchased_credit_balance)} purchased)`,
          );
        }
        return lines.join("\n");
      },
      context: async () => {
        const breakdown = await getAgentContextOverview<{
          context_window_size_current?: number;
          context_window_size_max?: number;
        }>(target.agentId).catch(() => undefined);
        return renderContextUsage({
          usedTokens: breakdown?.context_window_size_current ?? 0,
          contextWindow: breakdown?.context_window_size_max ?? 0,
          model: active?.store.getSnapshot().session?.model ?? "unknown",
          history: [],
          ...(breakdown ? { breakdown: breakdown as never } : {}),
        });
      },
    }),
    [target.agentId, active],
  );

  const switchSession = useCallback(
    (next: SessionTarget) => {
      setAgentName((current) =>
        next.agentId === target.agentId ? current : null,
      );
      setTarget(next);
    },
    [target.agentId],
  );

  if (failure) {
    return (
      <Box flexDirection="column">
        <Text color="red">{`Unable to start the App Server session: ${failure}`}</Text>
      </Box>
    );
  }
  if (!active || active.target !== target) {
    return <Text dimColor>Starting session…</Text>;
  }
  return (
    <TuiRoot
      key={`${target.agentId}:${target.conversationId}`}
      store={active.store}
      agentId={target.agentId}
      agentName={agentName}
      conversationId={target.conversationId}
      hostLabel={active.hostLabel}
      switchSession={switchSession}
      renameAgent={setAgentName}
      services={services}
      isLocalBackend={getBackend().capabilities.localModelCatalog}
    />
  );
}

export function App({
  agentId,
  agentState,
  conversationId,
  loadingState = "ready",
  continueSession,
  startupHasAvailableLocalModels,
}: AppProps) {
  if (loadingState !== "ready" || agentId === "loading") {
    return (
      <WelcomeScreen
        loadingState={loadingState}
        continueSession={continueSession}
        agentState={agentState}
        startupHasAvailableLocalModels={startupHasAvailableLocalModels}
      />
    );
  }
  return (
    <SessionApp
      initial={{ agentId, conversationId }}
      initialAgentName={agentState?.name ?? null}
    />
  );
}
