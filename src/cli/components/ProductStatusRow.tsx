import { Box } from "ink";
import Link from "ink-link";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getSnapshot as getSubagentSnapshot,
  type SubagentState,
  subscribe as subscribeToSubagents,
} from "@/agent/subagent-state";
import { BlinkingSpinner } from "./BlinkingSpinner.js";
import { colors } from "./colors";
import { Text } from "./Text";

const MAX_PRODUCT_STATUS_INDICATORS = 1;
const DREAMING_STATUS_PRIORITY = 50;

interface ProductStatusIndicator {
  id: string;
  priority: number;
  node: ReactNode;
}

function getActiveBackgroundAgents(snapshot: {
  agents: SubagentState[];
}): SubagentState[] {
  return snapshot.agents.filter(
    (agent) =>
      agent.silent === true &&
      (agent.status === "pending" || agent.status === "running"),
  );
}

function typeLabelForBackgroundAgent(agent: SubagentState): string {
  const rawType = agent.type.toLowerCase();
  return rawType === "reflection" ? "dreaming" : rawType;
}

function chatUrlForBackgroundAgent(
  agent: Pick<SubagentState, "agentURL">,
): string | null {
  return agent.agentURL?.startsWith("http") ? agent.agentURL : null;
}

function shouldRenderPlainBackgroundAgentUrl(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.TMUX);
}

function visibleProductStatusIndicators(
  indicators: ProductStatusIndicator[],
): ProductStatusIndicator[] {
  return [...indicators]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_PRODUCT_STATUS_INDICATORS);
}

function debugBackgroundAgent(): SubagentState | null {
  if (process.env.LETTA_DEBUG_FOOTER !== "1") {
    return null;
  }

  return {
    id: "debug-bg-agent",
    type: "Reflection",
    description: "Debug background agent",
    status: "running",
    agentURL: "https://app.letta.com/chat/agent-debug-link",
    toolCalls: [],
    maxToolCallsSeen: 0,
    totalTokens: 0,
    durationMs: 0,
    startTime: Date.now() - 12_000,
    isBackground: true,
    silent: true,
  };
}

function renderDreamingStatus(agent: SubagentState): ReactNode {
  const elapsedS = Math.round((Date.now() - agent.startTime) / 1000);
  const typeLabel = typeLabelForBackgroundAgent(agent);
  const chatUrl = chatUrlForBackgroundAgent(agent);
  const renderPlainUrl = shouldRenderPlainBackgroundAgentUrl();

  return (
    <Text>
      <BlinkingSpinner
        color={colors.bgSubagent.spinner}
        width={2}
        marginRight={0}
        pulseIntervalMs={400}
      />
      {chatUrl && renderPlainUrl ? (
        <>
          <Text color={colors.bgSubagent.label}>{typeLabel}</Text>
          <Text dimColor> {chatUrl}</Text>
        </>
      ) : chatUrl ? (
        <Link url={chatUrl}>
          <Text color={colors.bgSubagent.label}>{typeLabel}</Text>
        </Link>
      ) : (
        <Text color={colors.bgSubagent.label}>{typeLabel}</Text>
      )}
      <Text dimColor> ({elapsedS}s)</Text>
    </Text>
  );
}

export function ProductStatusRow({ terminalWidth }: { terminalWidth: number }) {
  const snapshot = useSyncExternalStore(
    subscribeToSubagents,
    getSubagentSnapshot,
  );
  const [, setElapsedTick] = useState(0);

  const activeBackgroundAgents = useMemo(() => {
    const debugAgent = debugBackgroundAgent();
    return [
      ...getActiveBackgroundAgents(snapshot),
      ...(debugAgent ? [debugAgent] : []),
    ];
  }, [snapshot]);
  const dreamingAgent = activeBackgroundAgents[0];

  useEffect(() => {
    if (!dreamingAgent) {
      return;
    }

    const timer = setInterval(() => setElapsedTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [dreamingAgent]);

  const indicators: ProductStatusIndicator[] = [];
  if (dreamingAgent) {
    indicators.push({
      id: "dreaming",
      priority: DREAMING_STATUS_PRIORITY,
      node: renderDreamingStatus(dreamingAgent),
    });
  }

  const visibleIndicators = visibleProductStatusIndicators(indicators);
  const rowWidth = Math.max(0, terminalWidth - 1);

  if (visibleIndicators.length === 0 || rowWidth === 0) {
    return null;
  }

  return (
    <Box width={rowWidth} flexDirection="row" justifyContent="flex-end">
      {visibleIndicators.map((indicator) => (
        <Box key={indicator.id} flexShrink={0}>
          {indicator.node}
        </Box>
      ))}
    </Box>
  );
}
