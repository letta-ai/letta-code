export interface ContextData {
  contextWindow: number;
  usedTokens: number;
  model: string;
  breakdown: {
    system: number;
    coreMemory: number;
    externalMemory: number;
    summaryMemory: number;
    tools: number;
    messages: number;
  };
}

export interface MemoryViewerData {
  agent: { id: string; name: string; serverUrl: string };
  generatedAt: string;
  totalCommitCount: number;
  files: MemoryFile[];
  commits: MemoryCommit[];
  context?: ContextData;
  conversations?: ConversationInfo[];
  messages?: MessageInfo[];
  selectedConversationId?: string | null;
}

export interface MemoryFile {
  path: string;
  isSystem: boolean;
  frontmatter: Record<string, string>;
  content: string;
}

export interface MemoryCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  stats: string;
  diff?: string;
  truncated?: boolean;
  isReflection: boolean;
}

export interface ConversationInfo {
  id: string;
  created_at: string;
  last_run_completion?: string | null;
  label?: string | null;
}

export interface MessageInfo {
  id: string;
  role: string;
  content: string | unknown[];
  conversation_id?: string | null;
  created_at: string;
}
