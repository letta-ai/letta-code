import type { RuntimeStartExternalToolsGroup } from "@/types/app-server-protocol";
import {
  modelStatusFromRuntimeStart,
  prepareGatewayRegistrationPolicy,
} from "./gateway-registration-policy";
import type { GatewayRuntimeState } from "./gateway-runtime-state";
import { channelTagsForSources } from "./gateway-sources";
import type {
  ChannelGatewayClient,
  ChannelGatewayDelivery,
  ChannelGatewayHooks,
} from "./gateway-types";

export async function performGatewayRuntimeRegistration(options: {
  client: ChannelGatewayClient;
  hooks: ChannelGatewayHooks;
  state: GatewayRuntimeState;
  delivery: ChannelGatewayDelivery;
  policyOverride?: boolean;
  externalToolsOverride?: readonly RuntimeStartExternalToolsGroup[];
}): Promise<boolean> {
  const {
    client,
    hooks,
    state,
    delivery,
    policyOverride,
    externalToolsOverride,
  } = options;
  const prepared = externalToolsOverride
    ? { automaticRelay: policyOverride ?? false, tool: null }
    : await prepareGatewayRegistrationPolicy({
        hooks,
        runtime: delivery.runtime,
        sources: delivery.sources,
        ...(policyOverride === undefined ? {} : { override: policyOverride }),
      });
  const { automaticRelay, tool } = prepared;
  const externalTools =
    externalToolsOverride ?? (tool ? [{ tools: [tool] }] : []);
  const conversationTags = channelTagsForSources(delivery.sources);
  const signature = JSON.stringify({
    mode: delivery.defaultPermissionMode ?? null,
    automaticRelay,
    externalTools,
    conversationTags,
  });
  if (state.registrationSignature === signature && state.registration) {
    await state.registration;
    return automaticRelay;
  }

  const registration = client
    .runtimeStart({
      agent_id: delivery.runtime.agent_id,
      conversation_id: delivery.runtime.conversation_id,
      ...(conversationTags.length > 0
        ? { conversation_source_tags: conversationTags }
        : {}),
      ...(delivery.defaultPermissionMode
        ? { mode: delivery.defaultPermissionMode }
        : {}),
      recover_approvals: true,
      force_device_status: false,
      wait_for_replay: true,
      preserve_skill_sources: true,
      client_info: { name: "channel-gateway", title: "Channel Gateway" },
      external_tools: externalTools,
    })
    .then((response) => {
      if (!response.success) {
        throw new Error(response.error ?? "Failed to register channel runtime");
      }
      state.modelStatus = modelStatusFromRuntimeStart(
        response,
        delivery.runtime,
      );
    });
  state.registrationSignature = signature;
  state.registration = registration;
  try {
    await registration;
  } catch (error) {
    if (state.registration === registration) {
      state.registration = null;
      state.registrationSignature = null;
    }
    throw error;
  }
  return automaticRelay;
}
