import type { ReactNode } from "react";
import type * as DisplayComponents from "@/cli/display/DisplayComponents";
import type { ExtensionContext } from "@/cli/extensions/types";
import type { StatusLinePayload } from "@/cli/helpers/status-line-payload";

export interface StatuslineUiContext {
  currentModelProvider: string | null;
  goalStatusText: string | null;
  hasTemporaryModelOverride: boolean;
  isByokProvider: boolean;
  isLocalBackend: boolean;
  isOpenAICodexProvider: boolean;
  rightColumnWidth: number;
}

export interface StatuslineRenderContext extends ExtensionContext {
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
