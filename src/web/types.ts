export interface ContextData {
  contextWindow: number; // max tokens
  usedTokens: number; // current total
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
  generatedAt: string; // ISO 8601 timestamp
  totalCommitCount: number; // total commits in repo (may exceed commits.length)
  files: MemoryFile[];
  commits: MemoryCommit[];
  context?: ContextData; // from GET /v1/agents/{id}/context
}

export interface MemoryFile {
  path: string; // e.g. "system/persona/soul.md"
  isSystem: boolean; // under system/ directory
  isSkill: boolean; // under skills/ directory
  frontmatter: Record<string, string>;
  content: string; // raw markdown body (after frontmatter)
}

export interface PlanViewerData {
  agent: { name: string };
  planContent: string;
  planFilePath: string;
  generatedAt: string; // ISO 8601 timestamp
}

export interface MemoryCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string; // ISO 8601
  message: string;
  stats: string; // diffstat summary
  diff?: string; // full unified diff patch (only for recent N commits)
  truncated?: boolean; // diff was truncated due to size cap
  isReflection: boolean; // commit message matches reflection/sleeptime pattern
}
