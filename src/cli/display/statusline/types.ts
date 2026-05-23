import type { ReactNode } from "react";
import type { ModelReasoningEffort } from "@/agent/model";

export interface StatuslineRenderContext {
  agentName: string | null | undefined;
  currentModel: string | null | undefined;
  currentModelProvider: string | null | undefined;
  currentReasoningEffort: ModelReasoningEffort | null | undefined;
  goalStatusText: string | null | undefined;
  hasTemporaryModelOverride: boolean;
  isByokProvider: boolean;
  isLocalBackend: boolean;
  isOpenAICodexProvider: boolean;
  rightColumnWidth: number;
}

export type StatuslineRendererOutput = ReactNode | null;

export interface StatuslineRenderer {
  id: string;
  label: string;
  description: string;
  render: (context: StatuslineRenderContext) => StatuslineRendererOutput;
}
