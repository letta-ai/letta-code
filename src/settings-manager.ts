// In-memory settings manager that loads once and provides sync access

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type AgentBackendMode,
  isAgentIdCompatibleWithBackend,
  isCloudAgentId,
} from "./agent/agent-id";
import {
  type AgentSettings,
  clientPreferencesUpdate,
  readClientPreferences,
  readToolsetPreference,
  stripEmptyAgentSettings,
  toolsetPreferenceUpdate,
} from "./agent-settings";
import {
  getLocalBackendStorageDir,
  isLocalBackendEnvEnabled,
  LOCAL_BACKEND_DIR_ENV,
} from "./backend/local/paths";
import type { ExperimentId } from "./experiments/types";
import type { HooksConfig } from "./hooks/types";
import type { McpServerConfig } from "./mcp-client";
import type { PermissionRules } from "./permissions/types";
import type {
  ReflectionMergeMode,
  ReflectionTrigger,
  StoredReflectionSettings,
} from "./reflection-settings";
import { getRuntimeContext } from "./runtime-context";
import { trackBoundaryError } from "./telemetry/error-reporting";
import type { ToolsetPreference } from "./tools/toolset-types";
import type { ClientPreferences } from "./types/client-preferences";
import { debugWarn } from "./utils/debug.js";
import { exists, mkdir, readFile, writeFile } from "./utils/fs.js";
import {
  deleteSecureTokens,
  getSecureTokens,
  isKeychainAvailable,
  type SecureTokens,
  setSecureTokens,
} from "./utils/secrets.js";
import {
  isProjectSettingsPathGlobal,
  resolveGlobalSettingsPath,
  shouldIsolateHomeProjectConfig,
} from "./utils/settings-path.js";

/**
 * Reference to a session (agent + conversation pair).
 * Always tracked together since a conversation belongs to exactly one agent.
 */
export interface SessionRef {
  agentId: string;
  conversationId: string;
}

export interface WindowTitleConfig {
  items: string[]; // Ordered list of enabled field keys (e.g. ["agent-name", "model-name"])
}

export type { AgentSettings } from "./agent-settings";

export interface Settings {
  lastAgent: string | null; // DEPRECATED: kept for migration to lastSession
  lastSession?: SessionRef; // DEPRECATED: kept for backwards compat, use sessionsByServer
  tokenStreaming: boolean;
  reasoningTabCycleEnabled: boolean; // Tab cycles reasoning tiers only when explicitly enabled
  showCompactions?: boolean;
  sessionContextEnabled: boolean; // Send device/agent context on first message of each session
  autoConversationTitles: boolean; // Generate AI conversation titles when possible
  autoConversationTitlesRollbackApplied?: boolean; // One-time rollback marker for the default-on title experiment
  autoSwapOnQuotaLimit: boolean; // Auto-switch to temporary Auto model override on quota-limit errors
  includeWorktreeTool: boolean; // Include EnterWorktree in toolsets when true
  preferredBackendMode?: "api" | "local"; // Startup backend preference when no explicit --backend is provided
  channelCredentialsStore?: "file" | "keyring" | "auto"; // Where channel/connection tokens are persisted
  recentModels: string[]; // Recently used model IDs (most recent first, max 10)
  memoryReminderInterval: number | null | "compaction" | "auto-compaction"; // DEPRECATED: use reflection* fields
  reflectionTrigger: ReflectionTrigger;
  reflectionStepCount: number;
  // Controls whether reflection changes merge immediately or through primary-agent integration.
  reflectionMerge: ReflectionMergeMode;
  reflectionMergeInstructions: string;
  reflectionSettingsByAgent?: Record<string, StoredReflectionSettings>;
  conversationSwitchAlertEnabled: boolean; // Send system-reminder when switching conversations/agents
  profiles?: Record<string, string>; // DEPRECATED: old format, kept for migration
  createDefaultAgents?: boolean; // Create Memo/Incognito default agents on startup (default: true)
  permissions?: PermissionRules;
  hooks?: HooksConfig; // Hook commands that run at various lifecycle points (includes disabled flag)
  windowTitle?: WindowTitleConfig; // Configurable terminal window title
  env?: Record<string, string>;
  experiments?: Partial<Record<ExperimentId, boolean>>;
  sessionsByServer?: Record<string, SessionRef>; // key = normalized base URL (e.g., "api.letta.com", "localhost:8283")
  agents?: AgentSettings[];
  refreshToken?: string; // DEPRECATED: kept for migration, now stored in secrets
  tokenExpiresAt?: number; // Unix timestamp in milliseconds
  deviceId?: string;
  lastSeenReleaseNotesVersion?: string; // Base version of last seen release notes (e.g., "0.13.0")
  oauthState?: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    provider: "openai";
    timestamp: number;
  };
}

export interface StartupBackendSettings {
  preferredBackendMode?: Settings["preferredBackendMode"];
  envBaseUrl?: string;
}

// Shape of the `worktree` block in `.letta/settings.json`. The worktree tool
// reads this directly from disk (see readProvisionConfig) rather than through
// the settings manager, because provisioning runs against the primary checkout,
// which may not be the loaded project root.
export interface WorktreeProjectConfig {
  // Directories symlinked from the primary checkout into new worktrees to avoid
  // duplicating large gitignored trees. Defaults to ["node_modules"] when unset;
  // set to [] to disable.
  symlinkDirectories?: string[];
  // Copy .letta/settings.local.json into new worktrees. Defaults to true.
  copyLocalSettings?: boolean;
  // Point new worktrees at the primary checkout's git hooks (e.g. husky's
  // .husky/_), whose contents are otherwise gitignored and absent. Defaults to true.
  linkHooks?: boolean;
  // Extra repo-root-relative paths (files or directories) to copy into new
  // worktrees, merged with entries from a .worktreeinclude file. Use this for
  // gitignored config like .env that the worktree needs.
  include?: string[];
}

export interface ProjectSettings {
  hooks?: HooksConfig; // Project-specific hook commands (checked in)
  windowTitle?: WindowTitleConfig; // Project-specific terminal window title
}

export interface LocalProjectSettings {
  lastAgent: string | null; // DEPRECATED: kept for migration to lastSession
  lastSession?: SessionRef; // DEPRECATED: kept for backwards compat, use sessionsByServer
  permissions?: PermissionRules;
  hooks?: HooksConfig; // Project-specific hook commands
  windowTitle?: WindowTitleConfig; // Local project-specific terminal window title
  profiles?: Record<string, string>; // DEPRECATED: old format, kept for migration
  memoryReminderInterval?: number | null | "compaction" | "auto-compaction"; // DEPRECATED: use reflection* fields
  reflectionTrigger?: ReflectionTrigger;
  reflectionStepCount?: number;
  reflectionMerge?: ReflectionMergeMode;
  reflectionMergeInstructions?: string;
  reflectionSettingsByAgent?: Record<string, StoredReflectionSettings>;
  sessionsByServer?: Record<string, SessionRef>; // key = normalized base URL
  listenerEnvName?: string; // Saved environment name for listener connections (project-specific)
}

// Hard-deprecated keys: ignored on load and stripped from disk on persist.
const OBSOLETE_SETTINGS_KEYS = [
  "reflectionBehavior",
  "enableSleeptime",
  "pinnedAgents",
  "pinnedAgentsByServer",
  "pinnedConversationsByServer",
];

const DEFAULT_SETTINGS: Settings = {
  lastAgent: null,
  tokenStreaming: false,
  reasoningTabCycleEnabled: false,
  showCompactions: false,
  conversationSwitchAlertEnabled: false,
  sessionContextEnabled: true,
  autoConversationTitles: false,
  autoConversationTitlesRollbackApplied: true,
  autoSwapOnQuotaLimit: true,
  includeWorktreeTool: true,
  recentModels: [],
  memoryReminderInterval: 25, // DEPRECATED: use reflection* fields
  reflectionTrigger: "step-count",
  reflectionStepCount: 25,
  reflectionMerge: "auto",
  reflectionMergeInstructions: "",
};

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {};

const DEFAULT_LOCAL_PROJECT_SETTINGS: LocalProjectSettings = {
  lastAgent: null,
};

const DEFAULT_LETTA_API_URL = "https://api.letta.com";
const SETTINGS_BASE_URL_ENV = "LETTA_SETTINGS_BASE_URL";

function isSubagentProcess(): boolean {
  return process.env.LETTA_CODE_AGENT_ROLE === "subagent";
}

export function shouldPersistSessionState(): boolean {
  return (
    process.env.LETTA_CODE_AGENT_ROLE !== "subagent" &&
    process.env.LETTA_DISABLE_SESSION_PERSIST !== "1"
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  // Strip protocol
  let normalized = baseUrl.replace(/^https?:\/\//, "");
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, "");
  return normalized;
}

function getLocalBackendSettingsKey(): string {
  return `local:${resolve(getLocalBackendStorageDir())}`;
}

function isLocalServerKey(serverKey: string): boolean {
  return serverKey.startsWith("local:");
}

function isAgentIdCompatibleWithServerKey(
  agentId: string,
  serverKey: string,
): boolean {
  // A server key encodes the backend mode via its "local:" prefix, so
  // serverKey compatibility is just backend compatibility for that mode.
  return isAgentIdCompatibleWithBackend(
    agentId,
    isLocalServerKey(serverKey) ? "local" : "api",
  );
}

function isSessionCompatibleWithServerKey(
  session: SessionRef,
  serverKey: string,
): boolean {
  return isAgentIdCompatibleWithServerKey(session.agentId, serverKey);
}

function sessionsEqual(
  a: SessionRef | null | undefined,
  b: SessionRef | null | undefined,
): boolean {
  return a?.agentId === b?.agentId && a?.conversationId === b?.conversationId;
}

function shouldSkipLegacyLocalBackendSessionFallback(): boolean {
  return (
    isLocalBackendEnvEnabled() &&
    typeof process.env[LOCAL_BACKEND_DIR_ENV] === "string" &&
    process.env[LOCAL_BACKEND_DIR_ENV].length > 0
  );
}

function getApiServerKey(settings?: Settings | null): string {
  const baseUrl =
    process.env[SETTINGS_BASE_URL_ENV] ||
    settings?.env?.[SETTINGS_BASE_URL_ENV] ||
    process.env.LETTA_BASE_URL ||
    settings?.env?.LETTA_BASE_URL ||
    DEFAULT_LETTA_API_URL;
  return normalizeBaseUrl(baseUrl);
}

function getCurrentServerKey(settings?: Settings | null): string {
  if (isLocalBackendEnvEnabled()) {
    return getLocalBackendSettingsKey();
  }
  return getApiServerKey(settings);
}

function serverKeyForBackendMode(
  mode: AgentBackendMode,
  settings?: Settings | null,
): string {
  return mode === "local"
    ? getLocalBackendSettingsKey()
    : getApiServerKey(settings);
}

function getCurrentMemfsServerKey(settings?: Settings | null): string {
  if (isLocalBackendEnvEnabled()) {
    return getLocalBackendSettingsKey();
  }

  const baseUrl =
    process.env.LETTA_MEMFS_BASE_URL ||
    settings?.env?.LETTA_MEMFS_BASE_URL ||
    DEFAULT_LETTA_API_URL;
  return normalizeBaseUrl(baseUrl);
}

class SettingsManager {
  private settings: Settings | null = null;
  private projectSettings: Map<string, ProjectSettings> = new Map();
  private localProjectSettings: Map<string, LocalProjectSettings> = new Map();
  private initialized = false;
  private pendingWrites = new Set<Promise<void>>();
  private secretsAvailable: boolean | null = null;
  // Keys loaded from the file or explicitly set via updateSettings().
  // persistSettings() only writes these keys, so manual file edits for
  // keys we never touched are preserved instead of being clobbered by defaults.
  private managedKeys = new Set<string>();
  // Keys explicitly changed by this process. Only these keys are written back,
  // preventing stale in-memory values from clobbering external updates.
  private dirtyKeys = new Set<string>();
  private secureTokensCache: SecureTokens = {};

  // Mark keys as managed AND dirty (i.e. this process owns the value and it
  // should be written back on persist). The only call-site that should add to
  // managedKeys *without* calling this helper is the disk-load path in
  // initialize(), where we want to track the key but preserve external edits.
  private markDirty(...keys: string[]): void {
    for (const key of keys) {
      this.managedKeys.add(key);
      this.dirtyKeys.add(key);
    }
  }

  private updateSecureTokensCache(tokens: SecureTokens): void {
    if (tokens.apiKey) {
      this.secureTokensCache.apiKey = tokens.apiKey;
    }
    if (tokens.refreshToken) {
      this.secureTokensCache.refreshToken = tokens.refreshToken;
    }
  }

  private clearSecureTokensCache(): void {
    this.secureTokensCache = {};
  }

  private readJsonObjectSync(path: string): Record<string, unknown> {
    if (!exists(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  get isReady(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const settingsPath = this.getSettingsPath();
    let shouldRollbackAutoConversationTitles = false;

    try {
      if (!exists(settingsPath)) {
        this.settings = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          this.markDirty(key);
        }
        await this.persistSettings();
      } else {
        const content = await readFile(settingsPath);
        const loadedSettingsRaw = JSON.parse(content) as Record<
          string,
          unknown
        >;

        // Obsolete keys: drop from loaded settings and delete on next persist.
        for (const legacyKey of OBSOLETE_SETTINGS_KEYS) {
          if (Object.hasOwn(loadedSettingsRaw, legacyKey)) {
            delete loadedSettingsRaw[legacyKey];
            this.markDirty(legacyKey);
          }
        }
        shouldRollbackAutoConversationTitles =
          loadedSettingsRaw.autoConversationTitlesRollbackApplied !== true;
        if (shouldRollbackAutoConversationTitles) {
          loadedSettingsRaw.autoConversationTitles = false;
          loadedSettingsRaw.autoConversationTitlesRollbackApplied = true;
          this.markDirty(
            "autoConversationTitles",
            "autoConversationTitlesRollbackApplied",
          );
        }
        // Merge with defaults in case new fields were added
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...(loadedSettingsRaw as Partial<Settings>),
        };
        for (const key of Object.keys(loadedSettingsRaw)) {
          this.managedKeys.add(key);
        }
      }

      this.initialized = true;

      if (shouldRollbackAutoConversationTitles) {
        try {
          await this.persistSettings();
        } catch {
          // Best-effort cleanup only; do not fail the load path.
        }
      }

      await this.checkSecretsSupport();

      if (!isSubagentProcess()) {
        await this.migrateTokensToSecrets();
      }
    } catch (error) {
      trackBoundaryError({
        errorType: "settings_load_failed",
        error,
        context: "settings_initialize",
      });
      console.error("Error loading settings, using defaults:", error);
      this.settings = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        this.markDirty(key);
      }
      this.initialized = true;

      // Still check secrets support and try to migrate in case of partial failure
      await this.checkSecretsSupport();
      if (!isSubagentProcess()) {
        await this.migrateTokensToSecrets();
      }
    }
  }

  private async checkSecretsSupport(): Promise<void> {
    try {
      const available = await this.isKeychainAvailable();
      if (!available) {
        // Only show warning in debug mode - fallback storage is expected for npm users
        debugWarn(
          "secrets",
          "System secrets not available - using fallback storage",
        );
      }
    } catch (error) {
      debugWarn("secrets", `Could not check secrets availability: ${error}`);
    }
  }

  private async migrateTokensToSecrets(): Promise<void> {
    if (!this.settings) return;

    try {
      const tokensToMigrate: SecureTokens = {};
      let needsUpdate = false;

      if (this.settings.refreshToken) {
        tokensToMigrate.refreshToken = this.settings.refreshToken;
        needsUpdate = true;
      }

      if (this.settings.env?.LETTA_API_KEY) {
        tokensToMigrate.apiKey = this.settings.env.LETTA_API_KEY;
        needsUpdate = true;
      }

      if (needsUpdate && Object.keys(tokensToMigrate).length > 0) {
        const available = await this.isKeychainAvailable();
        if (available) {
          try {
            await setSecureTokens(tokensToMigrate);
            this.updateSecureTokensCache(tokensToMigrate);

            const updatedSettings = { ...this.settings };
            delete updatedSettings.refreshToken;

            if (updatedSettings.env?.LETTA_API_KEY) {
              const { LETTA_API_KEY: _, ...otherEnv } = updatedSettings.env;
              updatedSettings.env =
                Object.keys(otherEnv).length > 0 ? otherEnv : undefined;
            }

            this.settings = updatedSettings;
            this.markDirty("refreshToken", "env");
            await this.persistSettings();

            debugWarn("settings", "Successfully migrated tokens to secrets");
          } catch (error) {
            console.warn("Failed to migrate tokens to secrets:", error);
            console.warn("Tokens will remain in settings file for persistence");
          }
        } else {
          debugWarn(
            "settings",
            "Secrets not available - tokens will remain in settings file for persistence",
          );
        }
      }
    } catch (error) {
      console.warn("Failed to migrate tokens to secrets:", error);
      // Don't throw - app should still work with tokens in settings file
    }
  }

  /**
   * Get all settings (synchronous, from memory)
   * Note: Does not include secure tokens (API key, refresh token) from secrets
   */
  getSettings(): Settings {
    if (!this.initialized || !this.settings) {
      throw new Error(
        "Settings not initialized. Call settingsManager.initialize() first.",
      );
    }
    return { ...this.settings };
  }

  async getSettingsWithSecureTokens(): Promise<Settings> {
    const baseSettings = this.getSettings();
    const secureTokens: SecureTokens = { ...this.secureTokensCache };

    // Bun 1.3.0 can crash when keychain reads happen while AsyncLocalStorage
    // runtime scope is active. Reuse cached tokens in that case and let callers
    // fall back to env/file-backed settings if no cache is available yet.
    if (!getRuntimeContext()) {
      const secretsAvailable = await this.isKeychainAvailable();
      if (secretsAvailable) {
        const storedTokens = await this.getSecureTokens();
        secureTokens.apiKey = storedTokens.apiKey ?? secureTokens.apiKey;
        secureTokens.refreshToken =
          storedTokens.refreshToken ?? secureTokens.refreshToken;
      }
    }

    const fallbackRefreshToken =
      !secureTokens.refreshToken && baseSettings.refreshToken
        ? baseSettings.refreshToken
        : secureTokens.refreshToken;

    const fallbackApiKey =
      !secureTokens.apiKey && baseSettings.env?.LETTA_API_KEY
        ? baseSettings.env.LETTA_API_KEY
        : secureTokens.apiKey;

    return {
      ...baseSettings,
      env: {
        ...baseSettings.env,
        ...(fallbackApiKey && { LETTA_API_KEY: fallbackApiKey }),
      },
      refreshToken: fallbackRefreshToken,
    };
  }

  getSetting<K extends keyof Settings>(key: K): Settings[K] {
    return this.getSettings()[key];
  }

  shouldIncludeWorktreeTool(): boolean {
    return this.getSettings().includeWorktreeTool !== false;
  }

  setIncludeWorktreeTool(enabled: boolean): void {
    this.updateSettings({ includeWorktreeTool: enabled });
  }

  getRecentModels(): string[] {
    return this.getSettings().recentModels ?? [];
  }

  addRecentModel(modelId: string): void {
    const current = this.getRecentModels().filter((id) => id !== modelId);
    const updated = [modelId, ...current].slice(0, 10);
    this.updateSettings({ recentModels: updated });
  }

  getCachedSecureTokens(): SecureTokens {
    return { ...this.secureTokensCache };
  }

  getOrCreateDeviceId(): string {
    const settings = this.getSettings();
    let deviceId = settings.deviceId;
    if (!deviceId) {
      deviceId = randomUUID();
      this.updateSettings({ deviceId });
    }
    return deviceId;
  }

  updateSettings(updates: Partial<Settings>): void {
    if (!this.initialized || !this.settings) {
      throw new Error(
        "Settings not initialized. Call settingsManager.initialize() first.",
      );
    }

    const { env, refreshToken, ...otherUpdates } = updates;
    let apiKey: string | undefined;
    let updatedEnv = env;

    if (env?.LETTA_API_KEY) {
      apiKey = env.LETTA_API_KEY;
      // Remove from env to prevent storing in settings file
      const { LETTA_API_KEY: _, ...otherEnv } = env;
      updatedEnv = Object.keys(otherEnv).length > 0 ? otherEnv : undefined;
    }

    // Update in-memory settings (without sensitive tokens)
    this.settings = {
      ...this.settings,
      ...otherUpdates,
      ...(updatedEnv && { env: { ...this.settings.env, ...updatedEnv } }),
    };

    for (const key of Object.keys(otherUpdates)) {
      this.markDirty(key);
    }
    if (updatedEnv) {
      this.markDirty("env");
    }

    const secureTokens: SecureTokens = {};
    if (apiKey) {
      secureTokens.apiKey = apiKey;
    }
    if (refreshToken) {
      secureTokens.refreshToken = refreshToken;
    }

    const writePromise = this.persistSettingsAndTokens(secureTokens)
      .catch((error) => {
        trackBoundaryError({
          errorType: "settings_persist_failed",
          error,
          context: "settings_update",
        });
        console.error("Failed to persist settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
  }

  private async persistSettingsAndTokens(
    secureTokens: SecureTokens,
  ): Promise<void> {
    const secretsAvailable = await this.isKeychainAvailable();

    if (secretsAvailable && Object.keys(secureTokens).length > 0) {
      try {
        await Promise.all([
          this.persistSettings(),
          this.setSecureTokens(secureTokens),
        ]);
        return;
      } catch (error) {
        console.warn(
          "Failed to store tokens in secrets, falling back to settings file:",
          error,
        );
      }
    }

    if (Object.keys(secureTokens).length > 0) {
      debugWarn(
        "settings",
        "Secrets not available, storing tokens in settings file for persistence",
      );

      // biome-ignore lint/style/noNonNullAssertion: at this point will always exist
      const fallbackSettings: Settings = { ...this.settings! };

      if (secureTokens.refreshToken) {
        fallbackSettings.refreshToken = secureTokens.refreshToken;
        this.markDirty("refreshToken");
      }

      if (secureTokens.apiKey) {
        fallbackSettings.env = {
          ...fallbackSettings.env,
          LETTA_API_KEY: secureTokens.apiKey,
        };
        this.markDirty("env");
      }

      this.settings = fallbackSettings;
      await this.persistSettings();
    } else {
      await this.persistSettings();
    }
  }

  async loadProjectSettings(
    workingDirectory: string = process.cwd(),
  ): Promise<ProjectSettings> {
    // If cwd is HOME, .letta/settings.json is the global settings file.
    // Never treat it as project settings or we risk duplicate project/global behavior.
    if (this.isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
      const defaults = { ...DEFAULT_PROJECT_SETTINGS };
      this.projectSettings.set(workingDirectory, defaults);
      return defaults;
    }

    const cached = this.projectSettings.get(workingDirectory);
    if (cached) {
      return { ...cached };
    }

    const settingsPath = this.getProjectSettingsPath(workingDirectory);

    try {
      if (!exists(settingsPath)) {
        const defaults = { ...DEFAULT_PROJECT_SETTINGS };
        this.projectSettings.set(workingDirectory, defaults);
        return defaults;
      }

      const content = await readFile(settingsPath);
      const rawSettings = JSON.parse(content) as Record<string, unknown>;

      const projectSettings: ProjectSettings = {
        hooks: rawSettings.hooks as HooksConfig | undefined,
        windowTitle: rawSettings.windowTitle as WindowTitleConfig | undefined,
      };

      this.projectSettings.set(workingDirectory, projectSettings);
      return { ...projectSettings };
    } catch (error) {
      console.error("Error loading project settings, using defaults:", error);
      const defaults = { ...DEFAULT_PROJECT_SETTINGS };
      this.projectSettings.set(workingDirectory, defaults);
      return defaults;
    }
  }

  getProjectSettings(
    workingDirectory: string = process.cwd(),
  ): ProjectSettings {
    const cached = this.projectSettings.get(workingDirectory);
    if (!cached) {
      throw new Error(
        `Project settings for ${workingDirectory} not loaded. Call loadProjectSettings() first.`,
      );
    }
    return { ...cached };
  }

  updateProjectSettings(
    updates: Partial<ProjectSettings>,
    workingDirectory: string = process.cwd(),
  ): void {
    // If cwd is HOME, project settings path collides with global settings path.
    // Route overlapping keys to user settings and avoid writing project scope.
    if (this.isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
      const globalUpdates: Partial<Settings> = {};
      if ("hooks" in updates) {
        globalUpdates.hooks = updates.hooks;
      }
      if ("windowTitle" in updates) {
        globalUpdates.windowTitle = updates.windowTitle;
      }
      if (Object.keys(globalUpdates).length > 0) {
        this.updateSettings(globalUpdates);
      }
      return;
    }

    const current = this.projectSettings.get(workingDirectory);
    if (!current) {
      throw new Error(
        `Project settings for ${workingDirectory} not loaded. Call loadProjectSettings() first.`,
      );
    }

    const updated = { ...current, ...updates };
    this.projectSettings.set(workingDirectory, updated);

    // Persist asynchronously (track promise for testing)
    const writePromise = this.persistProjectSettings(workingDirectory)
      .catch((error) => {
        trackBoundaryError({
          errorType: "project_settings_persist_failed",
          error,
          context: "settings_project_update",
        });
        console.error("Failed to persist project settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
  }

  private async persistSettings(): Promise<void> {
    if (!this.settings) return;

    const settingsPath = this.getSettingsPath();
    const dirPath = dirname(settingsPath);

    try {
      if (!exists(dirPath)) {
        await mkdir(dirPath, { recursive: true, mode: 0o700 });
      }

      // Read existing file to preserve fields we don't manage (e.g., hooks added externally)
      let existingSettings: Record<string, unknown> = {};
      if (exists(settingsPath)) {
        try {
          const content = await readFile(settingsPath);
          existingSettings = JSON.parse(content) as Record<string, unknown>;
        } catch {
        }
      }

      // Hard-deprecate legacy fields (now fully ignored). Always strip from disk.
      for (const key of OBSOLETE_SETTINGS_KEYS) {
        delete existingSettings[key];
      }

      // Only write keys we loaded from the file or explicitly set via updateSettings().
      // This preserves manual file edits for keys we never touched (e.g. defaults).
      const merged: Record<string, unknown> = { ...existingSettings };
      const settingsRecord = this.settings as unknown as Record<
        string,
        unknown
      >;
      for (const key of this.managedKeys) {
        // Preserve external updates (including deletions) for keys this
        // process never touched.
        if (!this.dirtyKeys.has(key)) {
          continue;
        }
        if (key in settingsRecord) {
          merged[key] = settingsRecord[key];
        } else {
          delete merged[key];
        }
      }

      await writeFile(settingsPath, JSON.stringify(merged, null, 2), {
        directoryMode: 0o700,
        mode: 0o600,
      });
    } catch (error) {
      console.error("Error saving settings:", error);
      throw error;
    }
  }

  private async persistProjectSettings(
    workingDirectory: string,
  ): Promise<void> {
    // Safety guard: never persist project settings into global settings path.
    if (this.isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
      return;
    }

    const settings = this.projectSettings.get(workingDirectory);
    if (!settings) return;

    const settingsPath = this.getProjectSettingsPath(workingDirectory);
    const dirPath = join(workingDirectory, ".letta");

    try {
      // Read existing settings (might have permissions, etc.)
      let existingSettings: Record<string, unknown> = {};
      if (exists(settingsPath)) {
        const content = await readFile(settingsPath);
        existingSettings = JSON.parse(content) as Record<string, unknown>;
      }

      if (!exists(dirPath)) {
        await mkdir(dirPath, { recursive: true });
      }

      const newSettings = {
        ...existingSettings,
        ...settings,
      };

      await writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
    } catch (error) {
      console.error("Error saving project settings:", error);
      throw error;
    }
  }

  private getSettingsPath(): string {
    return resolveGlobalSettingsPath();
  }

  private getProjectSettingsPath(workingDirectory: string): string {
    return join(workingDirectory, ".letta", "settings.json");
  }

  private isProjectSettingsPathCollidingWithGlobal(
    workingDirectory: string,
  ): boolean {
    return isProjectSettingsPathGlobal(workingDirectory);
  }

  private getLocalProjectSettingsPath(workingDirectory: string): string {
    return join(workingDirectory, ".letta", "settings.local.json");
  }

  async loadLocalProjectSettings(
    workingDirectory: string = process.cwd(),
  ): Promise<LocalProjectSettings> {
    const cached = this.localProjectSettings.get(workingDirectory);
    if (cached) {
      return { ...cached };
    }

    if (shouldIsolateHomeProjectConfig(workingDirectory)) {
      const defaults = { ...DEFAULT_LOCAL_PROJECT_SETTINGS };
      this.localProjectSettings.set(workingDirectory, defaults);
      return defaults;
    }
    const settingsPath = this.getLocalProjectSettingsPath(workingDirectory);

    try {
      if (!exists(settingsPath)) {
        const defaults = { ...DEFAULT_LOCAL_PROJECT_SETTINGS };
        this.localProjectSettings.set(workingDirectory, defaults);
        return defaults;
      }

      const content = await readFile(settingsPath);
      const localSettingsRaw = JSON.parse(content) as Record<string, unknown>;

      const hadLegacyKeys = OBSOLETE_SETTINGS_KEYS.some((key) =>
        Object.hasOwn(localSettingsRaw, key),
      );
      for (const key of OBSOLETE_SETTINGS_KEYS) {
        delete localSettingsRaw[key];
      }
      const localSettings = localSettingsRaw as unknown as LocalProjectSettings;

      this.localProjectSettings.set(workingDirectory, localSettings);
      if (hadLegacyKeys) {
        try {
          await this.persistLocalProjectSettings(workingDirectory);
        } catch {
          // Best-effort cleanup only; do not fail load path.
        }
      }

      return { ...localSettings };
    } catch (error) {
      console.error(
        "Error loading local project settings, using defaults:",
        error,
      );
      const defaults = { ...DEFAULT_LOCAL_PROJECT_SETTINGS };
      this.localProjectSettings.set(workingDirectory, defaults);
      return defaults;
    }
  }

  getLocalProjectSettings(
    workingDirectory: string = process.cwd(),
  ): LocalProjectSettings {
    const cached = this.localProjectSettings.get(workingDirectory);
    if (!cached) {
      throw new Error(
        `Local project settings for ${workingDirectory} not loaded. Call loadLocalProjectSettings() first.`,
      );
    }
    return { ...cached };
  }

  updateLocalProjectSettings(
    updates: Partial<LocalProjectSettings>,
    workingDirectory: string = process.cwd(),
  ): void {
    if (shouldIsolateHomeProjectConfig(workingDirectory))
      throw new Error(
        "Cannot save project-local settings under HOME while LETTA_CONFIG_DIR is set",
      );
    const current = this.localProjectSettings.get(workingDirectory);
    if (!current) {
      throw new Error(
        `Local project settings for ${workingDirectory} not loaded. Call loadLocalProjectSettings() first.`,
      );
    }

    const updated = { ...current, ...updates };
    this.localProjectSettings.set(workingDirectory, updated);
    const writePromise = this.persistLocalProjectSettings(workingDirectory)
      .catch((error) => {
        console.error("Failed to persist local project settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
  }

  private async persistLocalProjectSettings(
    workingDirectory: string,
  ): Promise<void> {
    const settings = this.localProjectSettings.get(workingDirectory);
    if (!settings) return;

    const settingsPath = this.getLocalProjectSettingsPath(workingDirectory);
    const dirPath = join(workingDirectory, ".letta");

    try {
      if (!exists(dirPath)) {
        await mkdir(dirPath, { recursive: true });
      }

      // Read existing file to preserve fields we don't manage (e.g., hooks added externally)
      let existingSettings: Record<string, unknown> = {};
      if (exists(settingsPath)) {
        try {
          const content = await readFile(settingsPath);
          existingSettings = JSON.parse(content) as Record<string, unknown>;
        } catch {
        }
      }

      // Hard-deprecate legacy fields (now fully ignored). Always strip from disk.
      for (const key of OBSOLETE_SETTINGS_KEYS) {
        delete existingSettings[key];
      }

      const merged = {
        ...existingSettings,
        ...settings,
      };

      await writeFile(settingsPath, JSON.stringify(merged, null, 2));
    } catch (error) {
      console.error("Error saving local project settings:", error);
      throw error;
    }
  }

  getGlobalLastSession(): SessionRef | null {
    const settings = this.getSettings();
    const serverKey = getCurrentServerKey(settings);

    const serverSession = settings.sessionsByServer?.[serverKey];
    if (serverSession) {
      if (isSessionCompatibleWithServerKey(serverSession, serverKey)) {
        return serverSession;
      }
      debugWarn(
        "settings",
        "Ignoring incompatible global session for server %s: %s",
        serverKey,
        serverSession.agentId,
      );
    }

    if (shouldSkipLegacyLocalBackendSessionFallback()) {
      return null;
    }

    if (
      settings.lastSession &&
      isSessionCompatibleWithServerKey(settings.lastSession, serverKey)
    ) {
      return settings.lastSession;
    }

    return null;
  }

  getGlobalLastAgentId(): string | null {
    const settings = this.getSettings();
    const serverKey = getCurrentServerKey(settings);

    const serverSession = settings.sessionsByServer?.[serverKey];
    if (serverSession) {
      if (isSessionCompatibleWithServerKey(serverSession, serverKey)) {
        return serverSession.agentId;
      }
      debugWarn(
        "settings",
        "Ignoring incompatible global agent for server %s: %s",
        serverKey,
        serverSession.agentId,
      );
    }

    if (shouldSkipLegacyLocalBackendSessionFallback()) {
      return null;
    }

    if (
      settings.lastSession &&
      isSessionCompatibleWithServerKey(settings.lastSession, serverKey)
    ) {
      return settings.lastSession.agentId;
    }
    if (
      settings.lastAgent &&
      isAgentIdCompatibleWithServerKey(settings.lastAgent, serverKey)
    ) {
      return settings.lastAgent;
    }
    return null;
  }

  setGlobalLastSession(session: SessionRef): void {
    const settings = this.getSettings();
    const serverKey = getCurrentServerKey(settings);

    if (!isSessionCompatibleWithServerKey(session, serverKey)) {
      debugWarn(
        "settings",
        "Skipping incompatible global session write for server %s: %s",
        serverKey,
        session.agentId,
      );
      return;
    }

    const sessionsByServer = {
      ...settings.sessionsByServer,
      [serverKey]: session,
    };

    const existingServerSession = settings.sessionsByServer?.[serverKey];

    // Keep legacy global fields for cloud/self-hosted agents only.
    if (isCloudAgentId(session.agentId)) {
      if (
        sessionsEqual(existingServerSession, session) &&
        sessionsEqual(settings.lastSession, session) &&
        settings.lastAgent === session.agentId
      ) {
        return;
      }
      this.updateSettings({
        sessionsByServer,
        lastSession: session,
        lastAgent: session.agentId,
      });
      return;
    }

    if (sessionsEqual(existingServerSession, session)) {
      return;
    }
    this.updateSettings({ sessionsByServer });
  }

  getLocalLastSession(
    workingDirectory: string = process.cwd(),
  ): SessionRef | null {
    const globalSettings = this.getSettings();
    const serverKey = getCurrentServerKey(globalSettings);
    const localSettings = this.getLocalProjectSettings(workingDirectory);

    const serverSession = localSettings.sessionsByServer?.[serverKey];
    if (serverSession) {
      if (isSessionCompatibleWithServerKey(serverSession, serverKey)) {
        return serverSession;
      }
      debugWarn(
        "settings",
        "Ignoring incompatible local session for server %s: %s",
        serverKey,
        serverSession.agentId,
      );
    }

    if (shouldSkipLegacyLocalBackendSessionFallback()) {
      return null;
    }

    if (
      localSettings.lastSession &&
      isSessionCompatibleWithServerKey(localSettings.lastSession, serverKey)
    ) {
      return localSettings.lastSession;
    }

    return null;
  }

  getLocalLastAgentId(workingDirectory: string = process.cwd()): string | null {
    const globalSettings = this.getSettings();
    const serverKey = getCurrentServerKey(globalSettings);
    const localSettings = this.getLocalProjectSettings(workingDirectory);

    const serverSession = localSettings.sessionsByServer?.[serverKey];
    if (serverSession) {
      if (isSessionCompatibleWithServerKey(serverSession, serverKey)) {
        return serverSession.agentId;
      }
      debugWarn(
        "settings",
        "Ignoring incompatible local agent for server %s: %s",
        serverKey,
        serverSession.agentId,
      );
    }

    if (shouldSkipLegacyLocalBackendSessionFallback()) {
      return null;
    }

    if (
      localSettings.lastSession &&
      isSessionCompatibleWithServerKey(localSettings.lastSession, serverKey)
    ) {
      return localSettings.lastSession.agentId;
    }
    if (
      localSettings.lastAgent &&
      isAgentIdCompatibleWithServerKey(localSettings.lastAgent, serverKey)
    ) {
      return localSettings.lastAgent;
    }
    return null;
  }

  setLocalLastSession(
    session: SessionRef,
    workingDirectory: string = process.cwd(),
  ): void {
    const globalSettings = this.getSettings();
    const serverKey = getCurrentServerKey(globalSettings);
    const localSettings = this.getLocalProjectSettings(workingDirectory);

    if (!isSessionCompatibleWithServerKey(session, serverKey)) {
      debugWarn(
        "settings",
        "Skipping incompatible local session write for server %s: %s",
        serverKey,
        session.agentId,
      );
      return;
    }

    const sessionsByServer = {
      ...localSettings.sessionsByServer,
      [serverKey]: session,
    };

    if (
      sessionsEqual(localSettings.sessionsByServer?.[serverKey], session) &&
      sessionsEqual(localSettings.lastSession, session) &&
      localSettings.lastAgent === session.agentId
    ) {
      return;
    }

    // Also update legacy fields for backwards compat with older CLI versions
    this.updateLocalProjectSettings(
      {
        sessionsByServer,
        lastSession: session,
        lastAgent: session.agentId,
      },
      workingDirectory,
    );
  }

  getEffectiveLastSession(
    workingDirectory: string = process.cwd(),
  ): SessionRef | null {
    const localSession = this.getLocalLastSession(workingDirectory);
    if (localSession) {
      return localSession;
    }
    return this.getGlobalLastSession();
  }

  getEffectiveLastAgentId(
    workingDirectory: string = process.cwd(),
  ): string | null {
    const localAgentId = this.getLocalLastAgentId(workingDirectory);
    if (localAgentId) {
      return localAgentId;
    }
    return this.getGlobalLastAgentId();
  }

  /**
   * Persist the current session (agent + conversation) to both local and global
   * settings, plus the legacy lastAgent fields for backwards compat.
   *
   * This is the single entry-point every conversation/agent switch should use
   * instead of calling setLocalLastSession + setGlobalLastSession individually.
   */
  persistSession(
    agentId: string,
    conversationId: string,
    workingDirectory: string = process.cwd(),
  ): void {
    const session: SessionRef = { agentId, conversationId };
    if (!shouldIsolateHomeProjectConfig(workingDirectory))
      this.setLocalLastSession(session, workingDirectory);
    this.setGlobalLastSession(session);
  }

  getPinnedAgents(): string[] {
    return this.getPinnedAgentsForServerKey(
      getCurrentServerKey(this.getSettings()),
    );
  }

  getPinnedAgentsForBackendMode(mode: AgentBackendMode): string[] {
    return this.getPinnedAgentsForServerKey(
      serverKeyForBackendMode(mode, this.getSettings()),
    );
  }

  /**
   * Get pinned agent IDs for an explicit server key. The server key both
   * namespaces by server (baseUrl) and encodes the backend mode (the "local:"
   * prefix), so agent-id/backend compatibility is derived from it directly —
   * no separate backend-mode argument is needed.
   */
  getPinnedAgentsForServerKey(serverKey: string): string[] {
    const settings = this.getSettings();
    const normalizedBaseUrl =
      serverKey === "api.letta.com" ? undefined : serverKey;

    return (
      settings.agents
        ?.filter(
          (a) =>
            a.pinned &&
            (a.baseUrl ?? undefined) === normalizedBaseUrl &&
            isAgentIdCompatibleWithServerKey(a.agentId, serverKey),
        )
        .map((a) => a.agentId) ?? []
    );
  }

  isAgentPinned(agentId: string): boolean {
    return this.getPinnedAgents().includes(agentId);
  }

  pinAgent(agentId: string): void {
    this.upsertAgentSettings(agentId, { pinned: true });
  }

  unpinAgent(agentId: string): void {
    this.upsertAgentSettings(agentId, { pinned: false });
  }

  // DEPRECATED: Keep for backwards compatibility
  getGlobalProfiles(): Record<string, string> {
    return this.getSettings().profiles || {};
  }

  // DEPRECATED: Keep for backwards compatibility
  getLocalProfiles(
    workingDirectory: string = process.cwd(),
  ): Record<string, string> {
    const localSettings = this.getLocalProjectSettings(workingDirectory);
    return localSettings.profiles || {};
  }

  // DEPRECATED: Keep for backwards compatibility
  getMergedProfiles(
    _workingDirectory: string = process.cwd(),
  ): Array<{ name: string; agentId: string; isLocal: boolean }> {
    return this.getPinnedAgents().map((agentId) => ({
      name: "",
      agentId,
      isLocal: false,
    }));
  }

  shouldCreateDefaultAgents(): boolean {
    const settings = this.getSettings();
    return settings.createDefaultAgents !== false;
  }

  getListenerEnvName(
    workingDirectory: string = process.cwd(),
  ): string | undefined {
    try {
      const localSettings = this.getLocalProjectSettings(workingDirectory);
      return localSettings.listenerEnvName;
    } catch {
      // Settings not loaded yet
      return undefined;
    }
  }

  setListenerEnvName(
    envName: string,
    workingDirectory: string = process.cwd(),
  ): void {
    try {
      this.updateLocalProjectSettings(
        { listenerEnvName: envName },
        workingDirectory,
      );
    } catch {
      // Settings not loaded yet - load and retry
      this.loadLocalProjectSettings(workingDirectory)
        .then(() => {
          this.updateLocalProjectSettings(
            { listenerEnvName: envName },
            workingDirectory,
          );
        })
        .catch((error) => {
          console.error("Failed to save listener environment name:", error);
        });
    }
  }

  private getAgentSettings(
    agentId: string,
    serverKeyOverride?: string,
  ): AgentSettings | undefined {
    const settings = this.getSettings();
    const serverKey = serverKeyOverride ?? getCurrentServerKey(settings);
    const normalizedBaseUrl =
      serverKey === "api.letta.com" ? undefined : serverKey;

    return settings.agents?.find(
      (a) =>
        a.agentId === agentId && (a.baseUrl ?? undefined) === normalizedBaseUrl,
    );
  }

  private upsertAgentSettings(
    agentId: string,
    updates: Partial<
      Omit<
        AgentSettings,
        "agentId" | "baseUrl" | "systemPromptHash" | "systemPromptVersion"
      >
    > & {
      systemPromptHash?: string | null;
      systemPromptVersion?: string | null;
    },
    serverKeyOverride?: string,
  ): void {
    const settings = this.getSettings();
    const serverKey = serverKeyOverride ?? getCurrentServerKey(settings);
    const normalizedBaseUrl =
      serverKey === "api.letta.com" ? undefined : serverKey;

    const agents = [...(settings.agents || [])];
    const idx = agents.findIndex(
      (a) =>
        a.agentId === agentId && (a.baseUrl ?? undefined) === normalizedBaseUrl,
    );

    if (idx >= 0) {
      const existing = agents[idx] as AgentSettings;
      const updated: AgentSettings = {
        ...existing,
        ...updates,
        agentId: existing.agentId,
        baseUrl: existing.baseUrl,
        pinned: updates.pinned ?? existing.pinned,
        memfs: updates.memfs ?? existing.memfs,
        toolset: updates.toolset ?? existing.toolset,
        systemPromptPreset:
          updates.systemPromptPreset ?? existing.systemPromptPreset,
        systemPromptHash:
          updates.systemPromptHash === null
            ? undefined
            : (updates.systemPromptHash ?? existing.systemPromptHash),
        systemPromptVersion:
          updates.systemPromptVersion === null
            ? undefined
            : (updates.systemPromptVersion ?? existing.systemPromptVersion),
      };
      agents[idx] = stripEmptyAgentSettings(updated);
    } else {
      const newAgent: AgentSettings = {
        agentId,
        baseUrl: normalizedBaseUrl,
        ...updates,
        systemPromptHash: updates.systemPromptHash ?? undefined,
        systemPromptVersion: updates.systemPromptVersion ?? undefined,
      };
      agents.push(stripEmptyAgentSettings(newAgent));
    }

    this.updateSettings({ agents });
  }

  isMemfsEnabled(agentId: string): boolean {
    const settings = this.getSettings();
    const memfsServerKey = getCurrentMemfsServerKey(settings);
    return this.getAgentSettings(agentId, memfsServerKey)?.memfs === true;
  }

  /**
   * Whether memfs was EXPLICITLY disabled for this agent (memfs: false in
   * settings) — distinct from "never configured". Worker-style agents
   * created memfs-less record this so lazy repair paths don't re-enable.
   */
  isMemfsExplicitlyDisabled(agentId: string): boolean {
    const settings = this.getSettings();
    const memfsServerKey = getCurrentMemfsServerKey(settings);
    return this.getAgentSettings(agentId, memfsServerKey)?.memfs === false;
  }

  setMemfsEnabled(agentId: string, enabled: boolean): void {
    const settings = this.getSettings();
    const memfsServerKey = getCurrentMemfsServerKey(settings);
    this.upsertAgentSettings(agentId, { memfs: enabled }, memfsServerKey);
  }
  getMcpServers(agentId: string): McpServerConfig[] {
    return this.getAgentSettings(agentId)?.mcpServers ?? [];
  }
  setMcpServers(agentId: string, servers: McpServerConfig[]): void {
    this.upsertAgentSettings(agentId, { mcpServers: servers });
  }
  /** Resolve the manual override for one conversation; unset means auto. */
  getToolsetPreference(agentId: string, conversationId = "default") {
    return readToolsetPreference(
      this.getAgentSettings(agentId),
      conversationId,
    );
  }

  /** Persist a manual override for one conversation; auto clears it. */
  setToolsetPreference(
    agentId: string,
    preference: ToolsetPreference,
    conversationId: string = "default",
  ): void {
    const update = toolsetPreferenceUpdate(
      this.getAgentSettings(agentId),
      preference,
      conversationId,
    );
    if (update) this.upsertAgentSettings(agentId, update);
  }

  getClientPreferences(
    agentId: string,
    conversationId = "default",
  ): ClientPreferences {
    return readClientPreferences(
      this.getAgentSettings(agentId),
      conversationId,
    );
  }

  setClientPreferences(
    agentId: string,
    conversationId: string,
    preferences: ClientPreferences,
  ): void {
    const update = clientPreferencesUpdate(
      this.getAgentSettings(agentId),
      preferences,
      conversationId,
    );
    if (update) this.upsertAgentSettings(agentId, update);
  }

  getSystemPromptPreset(agentId: string): string | undefined {
    return this.getAgentSettings(agentId)?.systemPromptPreset;
  }

  getSystemPromptHash(agentId: string): string | undefined {
    return this.getAgentSettings(agentId)?.systemPromptHash;
  }

  getSystemPromptVersion(agentId: string): string | undefined {
    return this.getAgentSettings(agentId)?.systemPromptVersion;
  }

  setSystemPromptPreset(agentId: string, preset: string): void {
    this.upsertAgentSettings(agentId, {
      systemPromptPreset: preset,
      systemPromptHash: null,
      systemPromptVersion: null,
    });
  }

  setManagedSystemPrompt(
    agentId: string,
    prompt: {
      preset: string;
      hash: string;
      version: string;
    },
  ): void {
    this.upsertAgentSettings(agentId, {
      systemPromptPreset: prompt.preset,
      systemPromptHash: prompt.hash,
      systemPromptVersion: prompt.version,
    });
  }

  setSystemPromptCustom(agentId: string): void {
    this.upsertAgentSettings(agentId, {
      systemPromptPreset: "custom",
      systemPromptHash: null,
      systemPromptVersion: null,
    });
  }

  clearSystemPromptPreset(agentId: string): void {
    // Setting to empty string triggers the cleanup `if (!updated.systemPromptPreset) delete ...`
    this.upsertAgentSettings(agentId, {
      systemPromptPreset: "",
      systemPromptHash: null,
      systemPromptVersion: null,
    });
  }

  hasLocalLettaDir(workingDirectory: string = process.cwd()): boolean {
    const dirPath = join(workingDirectory, ".letta");
    return exists(dirPath);
  }

  storeOAuthState(
    state: string,
    codeVerifier: string,
    redirectUri: string,
    provider: "openai",
  ): void {
    this.updateSettings({
      oauthState: {
        state,
        codeVerifier,
        redirectUri,
        provider,
        timestamp: Date.now(),
      },
    });
  }

  getOAuthState(): Settings["oauthState"] | null {
    const settings = this.getSettings();
    return settings.oauthState || null;
  }

  clearOAuthState(): void {
    const settings = this.getSettings();
    const { oauthState: _, ...rest } = settings;
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
    this.markDirty("oauthState");
    this.persistSettings().catch((error) => {
      console.error(
        "Failed to persist settings after clearing OAuth state:",
        error,
      );
    });
  }

  async isKeychainAvailable(): Promise<boolean> {
    if (this.secretsAvailable === true) {
      return true;
    }

    const available = await isKeychainAvailable();
    // Cache only positive availability to avoid pinning transient failures
    // for the entire process lifetime.
    if (available) {
      this.secretsAvailable = true;
    }
    return available;
  }

  async getSecureTokens(): Promise<SecureTokens> {
    const available = await this.isKeychainAvailable();
    if (!available) {
      return {};
    }

    try {
      const tokens = await getSecureTokens();
      this.updateSecureTokensCache(tokens);
      return tokens;
    } catch (error) {
      trackBoundaryError({
        errorType: "secrets_retrieve_tokens_failed",
        error,
        context: "settings_secrets_retrieve",
      });
      console.warn("Failed to retrieve tokens from secrets:", error);
      return {};
    }
  }

  async setSecureTokens(tokens: SecureTokens): Promise<void> {
    this.updateSecureTokensCache(tokens);
    const available = await this.isKeychainAvailable();
    if (!available) {
      debugWarn(
        "settings",
        "Secrets not available, tokens will use fallback storage (not persistent across restarts)",
      );
      return;
    }

    try {
      await setSecureTokens(tokens);
    } catch (error) {
      trackBoundaryError({
        errorType: "secrets_store_tokens_failed",
        error,
        context: "settings_secrets_store",
      });
      console.warn(
        "Failed to store tokens in secrets, falling back to settings file",
      );
      // Let the caller handle the fallback by throwing again
      throw error;
    }
  }

  async deleteSecureTokens(): Promise<void> {
    this.clearSecureTokensCache();
    const available = await this.isKeychainAvailable();
    if (!available) {
      return;
    }

    try {
      await deleteSecureTokens();
    } catch (error) {
      trackBoundaryError({
        errorType: "secrets_delete_tokens_failed",
        error,
        context: "settings_secrets_delete",
      });
      console.warn("Failed to delete tokens from secrets:", error);
      // Continue anyway as the tokens might not exist
    }
  }

  /**
   * Wait for all pending writes to complete.
   * Useful in tests to ensure writes finish before cleanup.
   */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.pendingWrites));
  }

  async logout(): Promise<void> {
    try {
      await this.deleteSecureTokens();

      if (this.settings) {
        const updatedSettings = { ...this.settings };
        delete updatedSettings.refreshToken;
        delete updatedSettings.tokenExpiresAt;
        delete updatedSettings.deviceId;

        if (updatedSettings.env?.LETTA_API_KEY) {
          const { LETTA_API_KEY: _, ...otherEnv } = updatedSettings.env;
          updatedSettings.env =
            Object.keys(otherEnv).length > 0 ? otherEnv : undefined;
        }

        this.settings = updatedSettings;
        this.markDirty("refreshToken", "tokenExpiresAt", "deviceId", "env");
        await this.persistSettings();
      }
    } catch (error) {
      trackBoundaryError({
        errorType: "settings_logout_failed",
        error,
        context: "settings_logout",
      });
      console.error("Error during logout:", error);
      throw error;
    }
  }

  /**
   * Clear in-memory caches so the next read re-loads from disk.
   * Unlike reset(), this preserves the initialized state and pending writes.
   * Used by /reload to pick up settings changes without a full restart.
   */
  clearCaches(): void {
    this.localProjectSettings.clear();
    this.projectSettings.clear();
    this.clearSecureTokensCache();
  }

  async reset(): Promise<void> {
    // Wait for pending writes BEFORE clearing state
    await this.flush();

    this.settings = null;
    this.projectSettings.clear();
    this.localProjectSettings.clear();
    this.initialized = false;
    this.pendingWrites.clear();
    this.secretsAvailable = null;
    this.managedKeys.clear();
    this.dirtyKeys.clear();
    this.clearSecureTokensCache();
  }

  /**
   * Read the small subset of settings needed before CLI subcommand routing.
   * This intentionally avoids full SettingsManager initialization, which can
   * create defaults, mark dirty keys, and perform migrations/writes.
   */
  readStartupBackendSettingsSync(): StartupBackendSettings {
    const raw = this.readJsonObjectSync(this.getSettingsPath());
    const mode = raw.preferredBackendMode;
    const env = raw.env;
    const envBaseUrl =
      env && typeof env === "object" && !Array.isArray(env)
        ? (env as Record<string, unknown>).LETTA_BASE_URL
        : undefined;
    return {
      preferredBackendMode:
        mode === "api" || mode === "local" ? mode : undefined,
      envBaseUrl: typeof envBaseUrl === "string" ? envBaseUrl : undefined,
    };
  }
}

// Singleton instance - use globalThis to ensure only one instance across the entire bundle
declare global {
  var __lettaSettingsManager: SettingsManager | undefined;
}

if (!globalThis.__lettaSettingsManager) {
  globalThis.__lettaSettingsManager = new SettingsManager();
}

export const settingsManager = globalThis.__lettaSettingsManager;
