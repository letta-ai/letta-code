import type { EnsureLocalMemfsCheckoutOptions } from "@/agent/memory-filesystem";

export type ListMemoryCommandTestOverrides = {
  ensureLocalMemfsCheckout?: (
    agentId: string,
    options?: EnsureLocalMemfsCheckoutOptions,
  ) => Promise<void>;
  getMemoryFilesystemRoot?: (agentId: string) => string;
  isMemfsEnabledOnServer?: (agentId: string) => Promise<boolean>;
};
