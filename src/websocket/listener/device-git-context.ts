import {
  getGitContextAsync,
  type LightGitContext,
} from "@/cli/helpers/git-context";

const GIT_CONTEXT_CACHE_TTL_MS = 15_000;
const MAX_GIT_CONTEXT_CACHE_ENTRIES = 64;

type LoadGitContext = (cwd: string) => Promise<LightGitContext | null>;

type GitContextCacheEntry = {
  expiresAt: number;
  value: LightGitContext | null;
};

export class DeviceGitContextCache {
  private readonly entries = new Map<string, GitContextCacheEntry>();
  private readonly pending = new Map<string, Promise<LightGitContext | null>>();

  constructor(
    private readonly load: LoadGitContext = getGitContextAsync,
    private readonly now: () => number = Date.now,
  ) {}

  read(cwd: string): LightGitContext | null {
    const cached = this.entries.get(cwd);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    void this.refresh(cwd).catch(() => {});
    return cached?.value ?? null;
  }

  async refresh(
    cwd: string,
    options: { force?: boolean } = {},
  ): Promise<LightGitContext | null> {
    const cached = this.entries.get(cwd);
    if (!options.force && cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const pending = this.pending.get(cwd);
    if (pending) {
      return pending;
    }

    const load = this.load(cwd)
      .then((value) => {
        this.entries.set(cwd, {
          expiresAt: this.now() + GIT_CONTEXT_CACHE_TTL_MS,
          value,
        });
        this.prune();
        return value;
      })
      .finally(() => {
        this.pending.delete(cwd);
      });
    this.pending.set(cwd, load);
    return load;
  }

  private prune(): void {
    if (this.entries.size <= MAX_GIT_CONTEXT_CACHE_ENTRIES) {
      return;
    }
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
}

export const deviceGitContextCache = new DeviceGitContextCache();
