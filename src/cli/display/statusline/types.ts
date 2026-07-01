import type { ReactNode } from "react";
import type * as DisplayComponents from "@/cli/display/DisplayComponents";
import type { StatusLinePayload } from "@/cli/helpers/status-line-payload";
import type { ModContext } from "@/mods/types";

export interface StatuslineUiContext {
  currentModelProvider: string | null;
  hasTemporaryModelOverride: boolean;
  isByokProvider: boolean;
  isLocalBackend: boolean;
  isOpenAICodexProvider: boolean;
  rightColumnWidth: number;
}

export interface StatuslineRenderContext extends ModContext {
  rawPayload: StatusLinePayload;
  components: typeof DisplayComponents;
  statuses: Record<string, string>;
  ui: StatuslineUiContext;
}

export type StatuslineRendererOutput = ReactNode | null;

export interface StatuslineRenderer {
  id: string;
  label: string;
  description: string;
  render: (context: StatuslineRenderContext) => StatuslineRendererOutput;
}
