import type {
  CanUseToolContext,
  CanUseToolResponse,
  LettaCodeModelEntry,
  SDKQueueItem,
  SessionDeviceStatus,
  TranscriptRow,
} from "@letta-ai/letta-agent-sdk";
import type { AskUserQuestionReceipt } from "@/ask-user-question";
import type { sessionSubagents } from "@/cli/app/session-subagents";
import type { MemoryFileEntry } from "@/types/protocol_v2";
export type Approval = {
  name: string;
  input: Record<string, unknown>;
  context?: CanUseToolContext;
  resolve: (answer: CanUseToolResponse) => void;
};

export type Skill = {
  name: string;
  path: string;
  label: string;
  description: string;
  enabled: boolean;
  fixed?: boolean;
};

export type Snapshot = {
  rows: readonly TranscriptRow[];
  committed: number;
  notices: readonly {
    id: string;
    index: number;
    input?: string;
    text: string;
  }[];
  turnBytes: number;
  turnActive: boolean;
  epoch: number;
  queue: readonly SDKQueueItem[];
  pausedQueueIds?: readonly string[];
  resumedHistory?: boolean;
  approvals: readonly Approval[];
  status: "connecting" | "online" | "offline";
  error?: string;
  commandOutput?: string;
  device?: SessionDeviceStatus;
  question?: AskUserQuestionReceipt;
  login?: boolean;
  help?: boolean;
  model?: string;
  agentId?: string;
  agentName?: string;
  subagents?: ReturnType<typeof sessionSubagents>;
  tokens?: number;
  picker?: {
    kind: "agents" | "resume" | "model";
    items: { key: string; label: string; description?: string }[];
    after?: string;
    models?: LettaCodeModelEntry[];
    handles?: string[] | null;
    aliases?: Record<string, string>;
  };
  skills?: Skill[];
  memory?: {
    agentId: string;
    conversationId?: string;
    entries: MemoryFileEntry[];
  };
  activity?: string;
};
