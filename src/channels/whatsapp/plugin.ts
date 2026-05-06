import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAccount, WhatsAppChannelAccount } from "../types";
import { createWhatsAppAdapter } from "./adapter";
import { whatsappMessageActions } from "./messageActions";
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
