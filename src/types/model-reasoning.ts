export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Null means use the upstream provider's default. */
export type ModelReasoningSelection = ModelReasoningEffort | null;

export type ModelReasoningCapabilities = {
  supported_efforts?: ModelReasoningEffort[] | null;
  mandatory?: boolean;
};

export type ModelRuntimeStatus = {
  modelHandle: string | null;
  modelLabel: string;
  scope: "agent" | "conversation";
  contextWindow?: number;
  providerType?: string;
};
