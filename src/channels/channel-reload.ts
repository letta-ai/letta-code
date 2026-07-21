import {
  hydrateChannelAccountSecrets,
  LEGACY_CHANNEL_ACCOUNT_ID,
  listChannelAccounts,
  reloadChannelAccounts,
  replaceChannelAccountsInMemory,
} from "./accounts";
import {
  getSupportedChannelIds,
  restoreChannelPluginCache,
  snapshotChannelPluginCache,
} from "./plugin-registry";
import type { ChannelRestoreAgentScope } from "./restore-scope";
import { shouldRestoreChannelAccountForAgentScope } from "./restore-scope";
import {
  getRoutesForChannel,
  reloadRoutes,
  replaceRoutesInMemory,
} from "./routing";
import {
  buildSignalBaseUrlConflictError,
  findSignalBaseUrlConflict,
} from "./signal/account-conflicts";
import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelStartupLogger,
} from "./types";
import { isSignalChannelAccount } from "./types";

export type ChannelReloadOptions = {
  logger?: ChannelStartupLogger;
  forceReloadPlugins?: boolean;
  beforeRestart?: () => Promise<void> | void;
  afterRestart?: () => Promise<void> | void;
  timeoutMs?: number;
};

export interface ChannelReloadSummary {
  restarted: string[];
  stopped: string[];
  failures: ChannelReloadFailure[];
  bufferedDeliveries: number;
}

export interface ChannelReloadFailure {
  channelId: string;
  accountId?: string;
  error: string;
}

export function normalizeTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return undefined;
  }
  return Math.floor(timeoutMs);
}

export async function withChannelReloadTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    return promise;
  }

  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(message)),
          normalizedTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type AdapterSnapshot = Map<
  string,
  { adapter: ChannelAdapter; wasRunning: boolean }
>;

type ChannelReloadCoordinatorDependencies = {
  adapters: Map<string, ChannelAdapter>;
  getAdapterKey: (channelId: string, accountId?: string) => string;
  beginBuffering: () => {
    finish: () => Promise<void> | void;
    bufferedCount: () => number;
  };
  startChannelAccount: (
    channelId: string,
    accountId: string,
    options: {
      logger?: ChannelStartupLogger;
      forceReloadPlugin?: boolean;
      startTimeoutMs?: number;
    },
  ) => Promise<boolean>;
  registerAdapter: (adapter: ChannelAdapter) => void;
  log: (logger: ChannelStartupLogger | undefined, message: string) => void;
  createError: (failures: ChannelReloadFailure[]) => Error;
};

export class ChannelReloadCoordinator {
  private activeReload: Promise<ChannelReloadSummary> | null = null;
  private readonly pendingReloadHooks: (() => Promise<void> | void)[] = [];
  private readonly pendingPostReloadHooks: (() => Promise<void> | void)[] = [];
  private reloadPassStarted = false;
  private rerunRequested = false;
  private pendingForceReload = false;
  private configuredChannelNames: string[] = [];
  private restoreAgentScope: ChannelRestoreAgentScope | null | undefined;

  constructor(private readonly deps: ChannelReloadCoordinatorDependencies) {}

  reset(): void {
    this.activeReload = null;
    this.pendingReloadHooks.length = 0;
    this.pendingPostReloadHooks.length = 0;
    this.reloadPassStarted = false;
    this.rerunRequested = false;
    this.pendingForceReload = false;
  }

  setConfiguredScope(
    channelNames: string[],
    restoreAgentScope?: ChannelRestoreAgentScope | null,
  ): void {
    this.configuredChannelNames = Array.from(new Set(channelNames));
    this.restoreAgentScope = restoreAgentScope;
  }

  addConfiguredChannel(channelId: string): void {
    if (!this.configuredChannelNames.includes(channelId)) {
      this.configuredChannelNames.push(channelId);
    }
  }

  removeConfiguredChannel(channelId: string): void {
    this.configuredChannelNames = this.configuredChannelNames.filter(
      (configured) => configured !== channelId,
    );
  }

  reload(options: ChannelReloadOptions = {}): Promise<ChannelReloadSummary> {
    if (options.beforeRestart) {
      this.pendingReloadHooks.push(options.beforeRestart);
    }
    if (options.afterRestart) {
      this.pendingPostReloadHooks.push(options.afterRestart);
    }
    this.pendingForceReload ||= options.forceReloadPlugins === true;
    if (this.activeReload) {
      if (this.reloadPassStarted) this.rerunRequested = true;
      return this.activeReload;
    }

    const activeReload = this.run(options).finally(() => {
      if (this.activeReload === activeReload) this.activeReload = null;
    });
    this.activeReload = activeReload;
    return activeReload;
  }

  private async run(
    options: ChannelReloadOptions,
  ): Promise<ChannelReloadSummary> {
    const buffering = this.deps.beginBuffering();
    const summary: ChannelReloadSummary = {
      restarted: [],
      stopped: [],
      failures: [],
      bufferedDeliveries: 0,
    };
    try {
      while (true) {
        while (this.pendingReloadHooks.length > 0) {
          await this.runReloadHookBatch(
            this.pendingReloadHooks,
            options.timeoutMs,
          );
        }
        this.rerunRequested = false;
        const forceReloadPlugins = this.pendingForceReload;
        this.pendingForceReload = false;
        this.reloadPassStarted = true;
        const pass = await this.reloadAdapters({
          ...options,
          forceReloadPlugins,
        });
        summary.restarted.push(...pass.restarted);
        summary.stopped.push(...pass.stopped);

        if (this.rerunRequested || this.pendingReloadHooks.length > 0) {
          continue;
        }
        while (this.pendingPostReloadHooks.length > 0) {
          await this.runReloadHookBatch(
            this.pendingPostReloadHooks,
            options.timeoutMs,
          );
          if (this.rerunRequested || this.pendingReloadHooks.length > 0) break;
        }
        if (!this.rerunRequested && this.pendingReloadHooks.length === 0) break;
      }
      return {
        ...summary,
        restarted: Array.from(new Set(summary.restarted)),
        stopped: Array.from(new Set(summary.stopped)),
        bufferedDeliveries: buffering.bufferedCount(),
      };
    } catch (error) {
      this.pendingReloadHooks.length = 0;
      this.pendingPostReloadHooks.length = 0;
      throw error;
    } finally {
      this.reloadPassStarted = false;
      this.rerunRequested = false;
      this.pendingForceReload = false;
      await buffering.finish();
    }
  }

  private async runReloadHookBatch(
    queue: (() => Promise<void> | void)[],
    timeoutMs: number | undefined,
  ) {
    const hooks = queue.splice(0);
    for (const hook of hooks) {
      await withChannelReloadTimeout(
        Promise.resolve(hook()),
        timeoutMs,
        "Timed out waiting for active channel turns to finish before channel reload",
      );
    }
  }

  private async reloadAdapters(
    options: ChannelReloadOptions,
  ): Promise<ChannelReloadSummary> {
    const configured = this.configuredChannelNames;
    const channelIds = this.restoreAgentScope
      ? Array.from(new Set([...configured, ...getSupportedChannelIds()]))
      : configured.length > 0
        ? configured
        : Array.from(
            new Set(
              Array.from(this.deps.adapters.values()).map(
                (adapter) => adapter.channelId ?? adapter.id,
              ),
            ),
          );
    const requested = new Set(channelIds);
    const pluginCacheSnapshot = snapshotChannelPluginCache(channelIds);
    const accountSnapshots = new Map(
      channelIds.map((channelId) => [
        channelId,
        listChannelAccounts(channelId),
      ]),
    );
    const routeSnapshots = new Map(
      channelIds.map((channelId) => [
        channelId,
        getRoutesForChannel(channelId),
      ]),
    );
    const restoreConfiguration = () => {
      for (const channelId of channelIds) {
        replaceChannelAccountsInMemory(
          channelId,
          accountSnapshots.get(channelId) ?? [],
        );
        replaceRoutesInMemory(channelId, routeSnapshots.get(channelId) ?? []);
      }
    };
    const desiredAccounts: Pick<ChannelAccount, "channel" | "accountId">[] = [];
    const desiredKeys = new Set<string>();
    const stopped: string[] = [];
    const restarted: string[] = [];
    const failures: ChannelReloadFailure[] = [];

    for (const channelId of channelIds) {
      try {
        reloadChannelAccounts(channelId);
        reloadRoutes(channelId);
        await hydrateChannelAccountSecrets(channelId);
      } catch (error) {
        failures.push({
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const accounts = listChannelAccounts(channelId);
      const restorableAccounts = accounts.filter(
        (account) =>
          account.enabled &&
          shouldRestoreChannelAccountForAgentScope(
            account,
            this.restoreAgentScope,
          ),
      );
      this.deps.log(
        options.logger,
        `reload ${channelId}: accounts=${accounts.length}, enabled=${restorableAccounts.length > 0 ? restorableAccounts.map((account) => account.accountId).join(",") : "none"}`,
      );

      if (channelId === "signal") {
        const conflict = findSignalBaseUrlConflict(
          restorableAccounts.filter(isSignalChannelAccount),
        );
        if (conflict) {
          failures.push({
            channelId,
            error: buildSignalBaseUrlConflictError(conflict),
          });
        }
      }

      for (const account of restorableAccounts) {
        desiredAccounts.push({
          channel: account.channel,
          accountId: account.accountId,
        });
        desiredKeys.add(
          this.deps.getAdapterKey(account.channel, account.accountId),
        );
      }
    }

    if (failures.length > 0) {
      restoreConfiguration();
      throw this.deps.createError(failures);
    }

    const scopedKeys = new Set(desiredKeys);
    for (const [key, adapter] of this.deps.adapters) {
      if (requested.has(adapter.channelId ?? adapter.id)) scopedKeys.add(key);
    }
    const snapshot: AdapterSnapshot = new Map();
    for (const key of scopedKeys) {
      const adapter = this.deps.adapters.get(key);
      if (adapter) {
        snapshot.set(key, { adapter, wasRunning: adapter.isRunning() });
      }
    }

    try {
      for (const [key, adapter] of Array.from(this.deps.adapters.entries())) {
        if (
          !requested.has(adapter.channelId ?? adapter.id) ||
          desiredKeys.has(key)
        ) {
          continue;
        }
        if (adapter.isRunning()) await adapter.stop();
        this.deps.adapters.delete(key);
        stopped.push(
          `${adapter.channelId ?? adapter.id}/${adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}`,
        );
      }

      for (const account of desiredAccounts) {
        try {
          const started = await this.deps.startChannelAccount(
            account.channel,
            account.accountId,
            {
              logger: options.logger,
              forceReloadPlugin: options.forceReloadPlugins,
              startTimeoutMs: options.timeoutMs,
            },
          );
          if (!started) {
            throw new Error(
              `Channel account disappeared during reload: ${account.channel}/${account.accountId}`,
            );
          }
          restarted.push(`${account.channel}/${account.accountId}`);
        } catch (error) {
          failures.push({
            channelId: account.channel,
            accountId: account.accountId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    } catch (error) {
      restoreChannelPluginCache(pluginCacheSnapshot);
      try {
        await this.restoreSnapshot(
          scopedKeys,
          snapshot,
          options.logger,
          options.timeoutMs,
        );
      } catch (rollbackError) {
        failures.push({
          channelId: "channels",
          error: `rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        });
      } finally {
        restoreConfiguration();
      }
      if (failures.length === 0) {
        failures.push({
          channelId: "channels",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw this.deps.createError(failures);
    }

    return { restarted, stopped, failures: [], bufferedDeliveries: 0 };
  }

  private async restoreSnapshot(
    scopedKeys: Set<string>,
    snapshot: AdapterSnapshot,
    logger?: ChannelStartupLogger,
    startTimeoutMs?: number,
  ): Promise<void> {
    const failures: string[] = [];
    for (const key of scopedKeys) {
      const current = this.deps.adapters.get(key);
      const previous = snapshot.get(key)?.adapter;
      if (!current || current === previous) continue;
      try {
        if (current.isRunning()) await current.stop();
      } catch (error) {
        failures.push(
          `${key}: stop replacement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.deps.adapters.delete(key);
    }

    for (const [key, previous] of snapshot) {
      try {
        this.deps.registerAdapter(previous.adapter);
        if (previous.wasRunning && !previous.adapter.isRunning()) {
          this.deps.log(logger, `restarting previous adapter for ${key}`);
          await withChannelReloadTimeout(
            Promise.resolve(previous.adapter.start({ logger })),
            startTimeoutMs,
            `Timed out restarting previous adapter for ${key}`,
          );
        }
      } catch (error) {
        failures.push(
          `${key}: restart previous adapter failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Channel reload rollback failed:\n${failures.join("\n")}`,
      );
    }
  }
}

export class ChannelIngressBuffer<T> {
  private readonly items: T[] = [];
  private depth = 0;

  constructor(
    private readonly deps: {
      isReady: () => boolean;
      deliver: (item: T) => void;
    },
  ) {}

  begin(): { finish: () => void; bufferedCount: () => number } {
    this.depth += 1;
    const initialLength = this.items.length;
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        this.depth = Math.max(0, this.depth - 1);
        this.flush();
      },
      bufferedCount: () => Math.max(0, this.items.length - initialLength),
    };
  }

  isBuffering(): boolean {
    return this.depth > 0;
  }

  deliverOrBuffer(item: T): void {
    if (this.deps.isReady() && this.depth === 0) {
      this.deps.deliver(item);
    } else {
      this.items.push(item);
    }
  }

  flush(): void {
    if (!this.deps.isReady() || this.depth > 0) return;
    while (this.items.length > 0) {
      const item = this.items.shift();
      if (item) this.deps.deliver(item);
    }
  }

  reset(): void {
    this.items.length = 0;
    this.depth = 0;
  }
}
