/** Shapes shared by the script `memory` binding and its git backends. */

export interface MemoryLogEntry {
  sha: string;
  message: string;
  author: string;
  email: string;
  date: string;
}

export interface MemoryDiffEntry {
  path: string;
  state: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface MemoryAuthor {
  name: string;
  email: string;
}

export type MemoryChange =
  | { kind: "put"; path: string; content: string }
  | { kind: "delete"; path: string };

export interface MemoryCommitRequest {
  message: string;
  /** Target branch; created from `base` when it does not exist. */
  branch: string;
  base: string;
  author: MemoryAuthor;
  changes: MemoryChange[];
}

export interface MemoryCommitResult {
  sha: string;
  branch: string;
  changed: boolean;
}

export interface MemoryRepoBackend {
  /** Branch reads default to and commits target when none is given. */
  readonly defaultRef: string;
  read(path: string, ref: string): Promise<string | null>;
  list(options: { path?: string; ref: string }): Promise<string[]>;
  log(options: {
    path?: string;
    ref: string;
    limit: number;
  }): Promise<MemoryLogEntry[]>;
  diff(options: { base: string; ref: string }): Promise<MemoryDiffEntry[]>;
  commit(request: MemoryCommitRequest): Promise<MemoryCommitResult>;
}

/** Repository-relative POSIX path; rejects escapes before any write or read. */
export function normalizeMemoryPath(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("memory paths must be non-empty strings.");
  }
  const parts = path.replaceAll("\\", "/").split("/");
  const kept = parts.filter((part) => part !== "" && part !== ".");
  if (path.startsWith("/") || kept.some((part) => part === "..")) {
    throw new Error(`memory path must stay inside the repository: ${path}`);
  }
  if (kept[0] === ".git") {
    throw new Error(`memory path must not touch .git: ${path}`);
  }
  return kept.join("/");
}
