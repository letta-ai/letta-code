import type { ModCapabilities } from "@/mods/types";

export const MOD_CAPABILITY_IDS = [
  "tools",
  "commands",
  "providers",
  "permissions",
  "events.lifecycle",
  "events.turns",
  "events.tools",
  "ui.panels",
  "ui.statusValues",
  "ui.statusline",
] as const;

export type ModCapabilityId = (typeof MOD_CAPABILITY_IDS)[number];

export const DEFAULT_MOD_CAPABILITIES: ModCapabilities = {
  tools: true,
  commands: true,
  events: {
    lifecycle: true,
    tools: true,
    turns: true,
  },
  permissions: true,
  providers: true,
  ui: {
    panels: true,
    statusValues: true,
    customStatuslineRenderer: true,
  },
};

export const DISABLED_MOD_CAPABILITIES: ModCapabilities = {
  tools: false,
  commands: false,
  events: {
    lifecycle: false,
    tools: false,
    turns: false,
  },
  permissions: false,
  providers: false,
  ui: {
    panels: false,
    statusValues: false,
    customStatuslineRenderer: false,
  },
};

export function cloneModCapabilities(
  capabilities: ModCapabilities,
): ModCapabilities {
  return {
    tools: capabilities.tools,
    commands: capabilities.commands,
    events: {
      lifecycle: capabilities.events.lifecycle,
      tools: capabilities.events.tools,
      turns: capabilities.events.turns,
    },
    permissions: capabilities.permissions,
    providers: capabilities.providers,
    ui: {
      panels: capabilities.ui.panels,
      statusValues: capabilities.ui.statusValues,
      customStatuslineRenderer: capabilities.ui.customStatuslineRenderer,
    },
  };
}

export function resolveModCapabilities(
  capabilities?: ModCapabilities,
): ModCapabilities {
  return cloneModCapabilities(capabilities ?? DEFAULT_MOD_CAPABILITIES);
}
