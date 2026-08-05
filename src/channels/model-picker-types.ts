import type {
  ModelReasoningEffort,
  ModelReasoningSelection,
} from "@/types/model-reasoning";
import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";

export type ChannelReasoningEffort = ModelReasoningEffort;
export type ChannelReasoningSelection = ModelReasoningSelection;

export type ChannelModelPickerData = {
  current: {
    modelLabel: string;
    modelHandle: string | null;
    scope?: "agent" | "conversation";
  };
  entries: ListModelsResponseModelEntry[];
  availableHandles?: string[] | null;
  recentHandles?: string[];
  reasoningOptions?: Array<{
    effort: ChannelReasoningSelection;
    modelId: string;
  }>;
};
