import type { ModCapabilities } from "@/mods/types";

export const MOD_CAPABILITY_IDS = [
  "tools",
  "commands",
  "providers",
  "permissions",
  "events.lifecycle",
  "events.turns",
  "events.tools",
  "events.compact",
  "events.llm",
  "ui.panels",
] as const;

export type ModCapabilityId = (typeof MOD_CAPABILITY_IDS)[number];

const MOD_CAPABILITY_ID_SET = new Set<string>(MOD_CAPABILITY_IDS);

export function isModCapabilityId(value: string): value is ModCapabilityId {
  return MOD_CAPABILITY_ID_SET.has(value);
}

export const DEFAULT_MOD_CAPABILITIES: ModCapabilities = {
  tools: true,
  commands: true,
  events: {
    lifecycle: true,
    tools: true,
    turns: true,
    compact: true,
    llm: true,
  },
  permissions: true,
  providers: true,
  ui: {
    panels: true,
  },
};

export const DISABLED_MOD_CAPABILITIES: ModCapabilities = {
  tools: false,
  commands: false,
  events: {
    lifecycle: false,
    tools: false,
    turns: false,
    compact: false,
    llm: false,
  },
  permissions: false,
  providers: false,
  ui: {
    panels: false,
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
      compact: capabilities.events.compact,
      llm: capabilities.events.llm,
    },
    permissions: capabilities.permissions,
    providers: capabilities.providers,
    ui: {
      panels: capabilities.ui.panels,
    },
  };
}

export function resolveModCapabilities(
  capabilities?: ModCapabilities,
): ModCapabilities {
  return cloneModCapabilities(capabilities ?? DEFAULT_MOD_CAPABILITIES);
}
