import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, WhatsAppChannelAccount } from "@/channels/types";
import { createWhatsAppAdapter } from "./adapter";
import { whatsappMessageActions } from "./message-actions";
import { runWhatsAppSetup } from "./setup";

export const whatsappChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "whatsapp",
    displayName: "WhatsApp",
    runtimePackages: [
      "@whiskeysockets/baileys@6.7.21",
      "qrcode-terminal@0.12.0",
    ],
    runtimeModules: ["@whiskeysockets/baileys", "qrcode-terminal"],
    source: "first-party",
    firstParty: true,
  },
  createAdapter(account: ChannelAccount) {
    return createWhatsAppAdapter(account as WhatsAppChannelAccount);
  },
  messageActions: whatsappMessageActions,
  runSetup() {
    return runWhatsAppSetup();
  },
};
