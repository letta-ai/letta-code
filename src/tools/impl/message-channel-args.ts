/**
 * Runtime argument injection for the MessageChannel tool.
 *
 * parentScope and channelTurnSources are authorization inputs the tool
 * trusts (routing checks and delivery grants key off them). They may
 * only originate from the runtime, so model-supplied values are always
 * dropped — even when no runtime value replaces them; there is no
 * client-side schema validation to reject unexpected argument keys.
 */

import type { ChannelTurnSource } from "@/channels/types";

export function injectMessageChannelRuntimeArgs(
  args: Record<string, unknown>,
  runtime?: {
    parentScope?: { agentId: string; conversationId: string };
    channelTurnSources?: ChannelTurnSource[];
  },
): Record<string, unknown> {
  const {
    parentScope: _modelParentScope,
    channelTurnSources: _modelChannelTurnSources,
    ...sanitized
  } = args;
  return {
    ...sanitized,
    ...(runtime?.parentScope ? { parentScope: runtime.parentScope } : {}),
    ...(runtime?.channelTurnSources?.length
      ? { channelTurnSources: runtime.channelTurnSources }
      : {}),
  };
}
