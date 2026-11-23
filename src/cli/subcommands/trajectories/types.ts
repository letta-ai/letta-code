export interface SessionManifestEntry {
  source: string;
  id: string;
  sessionId: string;
  file: string;
  sourcePath: string;
  project?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  records: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  reasoningRecords: number;
  firstUserPrompt?: string;
  bytes: number;
  diagnostics: number;
}

export interface TrajectoryExportError {
  source: string;
  sourcePath: string;
  error: string;
}

export interface TrajectoryManifest {
  version: 1;
  generatedAt: string;
  outDir: string;
  sources: Record<string, { discovered: number; exported: number }>;
  errors: TrajectoryExportError[];
  sessions: SessionManifestEntry[];
}
