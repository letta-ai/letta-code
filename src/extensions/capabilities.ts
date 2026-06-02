import type { ExtensionCapabilities } from "@/extensions/types";

export const DEFAULT_EXTENSION_CAPABILITIES: ExtensionCapabilities = {
  tools: true,
  commands: true,
  events: {
    lifecycle: true,
    tools: true,
    turns: true,
  },
  providers: true,
  ui: {
    panels: true,
    statusValues: true,
    customStatuslineRenderer: true,
  },
};

export const DISABLED_EXTENSION_CAPABILITIES: ExtensionCapabilities = {
  tools: false,
  commands: false,
  events: {
    lifecycle: false,
    tools: false,
    turns: false,
  },
  providers: false,
  ui: {
    panels: false,
    statusValues: false,
    customStatuslineRenderer: false,
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
      tools: capabilities.events.tools,
      turns: capabilities.events.turns,
    },
    providers: capabilities.providers,
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
