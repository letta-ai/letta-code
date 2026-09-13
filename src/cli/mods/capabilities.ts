import type { ModCapabilities } from "@/mods/types";

export const TUI_MOD_CAPABILITIES: ModCapabilities = {
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
