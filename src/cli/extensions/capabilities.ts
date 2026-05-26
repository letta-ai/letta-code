import type { ExtensionCapabilities } from "@/extensions/types";

export const TUI_EXTENSION_CAPABILITIES: ExtensionCapabilities = {
  tools: true,
  commands: true,
  events: {
    lifecycle: true,
  },
  ui: {
    panels: true,
    statusValues: true,
    customStatuslineRenderer: true,
  },
};
