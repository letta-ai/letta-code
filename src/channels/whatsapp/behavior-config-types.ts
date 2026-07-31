import type { WhatsAppAttachmentPolicyConfig } from "./attachment-policy-types";
import type { WhatsAppInboundDebounceConfig } from "./inbound-debounce-config-types";
import type { WhatsAppMessagePrefixConfig } from "./message-prefix-config-types";
import type { WhatsAppWaitingBehaviorConfig } from "./waiting-behavior-config-types";

export interface WhatsAppBehaviorConfig
  extends WhatsAppAttachmentPolicyConfig,
    WhatsAppInboundDebounceConfig,
    WhatsAppWaitingBehaviorConfig,
    WhatsAppMessagePrefixConfig {}
