import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/display/DisplayComponents";
import { formatStatuslineReasoningEffort } from "@/cli/display/statusline/formatting";
import type { StatuslineRenderContext } from "./types";

export function CommandHintSegment() {
  return <Text dimColor>Press / for commands</Text>;
}

export function AgentNameSegment({ name }: { name: string }) {
  return <Text color={colors.footer.agentName}>{name}</Text>;
}

export function ModelSegment({ model }: { model: string }) {
  return <Text dimColor>{model}</Text>;
}

export function ProviderSegment({ provider }: { provider: string }) {
  return <Text dimColor>{provider}</Text>;
}

export function ReasoningSegment({
  effort,
}: {
  effort: StatuslineRenderContext["currentReasoningEffort"];
}) {
  const label = formatStatuslineReasoningEffort(effort);
  if (!label) return null;
  return <Text dimColor>{label}</Text>;
}

export function GoalStatusSegment({ text }: { text: string }) {
  return <Text color="magenta">{text}</Text>;
}

export function SeparatorSegment({ value = " · " }: { value?: string }) {
  return <Text dimColor>{value}</Text>;
}

export function LocalBackendSegment() {
  return <Text color={colors.status.success}>local</Text>;
}

export function ByokIndicatorSegment({
  isOpenAICodexProvider,
}: {
  isOpenAICodexProvider: boolean;
}) {
  return <Text color={isOpenAICodexProvider ? "#74AA9C" : "yellow"}>▲</Text>;
}

export function TemporaryModelOverrideSegment() {
  return <Text color="yellow">▲</Text>;
}

export function shouldShowByokIndicator(
  context: Pick<
    StatuslineRenderContext,
    "isByokProvider" | "isOpenAICodexProvider"
  >,
): boolean {
  return context.isByokProvider || context.isOpenAICodexProvider;
}
