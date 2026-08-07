import type { ModPanelHandle } from "@/mods/types";

export function createNoopModPanelHandle(): ModPanelHandle {
  return { close() {}, update() {} };
}
