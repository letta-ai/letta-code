import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, SignalChannelAccount } from "@/channels/types";
import { createSignalAdapter } from "./adapter";
import { signalMessageActions } from "./message-actions";
import { runSignalSetup } from "./setup";

export const signalChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "signal",
    displayName: "Signal",
    runtimePackages: [],
    runtimeModules: [],
    source: "first-party",
    firstParty: true,
  },
  createAdapter(account: ChannelAccount) {
    return createSignalAdapter(account as SignalChannelAccount);
  },
  messageActions: signalMessageActions,
  runSetup() {
    return runSignalSetup();
  },
};
