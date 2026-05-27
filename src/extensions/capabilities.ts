import type { ExtensionCapabilities } from "@/extensions/types";

export const DEFAULT_EXTENSION_CAPABILITIES: ExtensionCapabilities = {
  tools: true,
  commands: true,
  events: {
    lifecycle: true,
    turns: true,
  },
  ui: {
    panels: true,
    statusValues: true,
    customStatuslineRenderer: true,
  },
};

export function cloneExtensionCapabilities(
  capabilities: ExtensionCapabilities,
): ExtensionCapabilities {
  return {
    tools: capabilities.tools,
    commands: capabilities.commands,
    events: {
      lifecycle: capabilities.events.lifecycle,
      turns: capabilities.events.turns,
    },
    ui: {
      panels: capabilities.ui.panels,
      statusValues: capabilities.ui.statusValues,
      customStatuslineRenderer: capabilities.ui.customStatuslineRenderer,
    },
  };
}

export function resolveExtensionCapabilities(
  capabilities?: ExtensionCapabilities,
): ExtensionCapabilities {
  return cloneExtensionCapabilities(
    capabilities ?? DEFAULT_EXTENSION_CAPABILITIES,
  );
}
