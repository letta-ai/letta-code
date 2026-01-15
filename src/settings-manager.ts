// src/settings-manager.ts
// In-memory settings manager that loads once and provides sync access

import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRules } from "./permissions/types";
import { debugWarn } from "./utils/debug.js";
import { exists, mkdir, readFile, writeFile } from "./utils/fs.js";
import {
  deleteSecureTokens,
  getSecureTokens,
  isKeychainAvailable,
  type SecureTokens,
  setSecureTokens,
} from "./utils/secrets.js";

/**
 * Reference to a session (agent + conversation pair).
 * Always tracked together since a conversation belongs to exactly one agent.
 */
export interface SessionRef {
  agentId: string;
  conversationId: string;
}

export interface Settings {
  lastAgent: string | null; // DEPRECATED: kept for migration to lastSession
  lastSession?: SessionRef; // Current session (agent + conversation)
  tokenStreaming: boolean;
  enableSleeptime: boolean;
  sessionContextEnabled: boolean; // Send device/agent context on first message of each session
  memoryReminderInterval: number | null; // null = disabled, number = prompt memory check every N turns
  globalSharedBlockIds: Record<string, string>; // DEPRECATED: kept for backwards compat
  profiles?: Record<string, string>; // DEPRECATED: old format, kept for migration
  pinnedAgents?: string[]; // Array of agent IDs pinned globally
  createDefaultAgents?: boolean; // Create Memo/Incognito default agents on startup (default: true)
  permissions?: PermissionRules;
  env?: Record<string, string>;
  // Letta Cloud OAuth token management (stored separately in secrets)
  refreshToken?: string; // DEPRECATED: kept for migration, now stored in secrets
  tokenExpiresAt?: number; // Unix timestamp in milliseconds
  deviceId?: string;
  // Pending OAuth state (for PKCE flow)
  oauthState?: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    provider: "openai";
    timestamp: number;
  };
}

export interface ProjectSettings {
  localSharedBlockIds: Record<string, string>;
}

export interface LocalProjectSettings {
  lastAgent: string | null; // DEPRECATED: kept for migration to lastSession
  lastSession?: SessionRef; // Current session (agent + conversation)
  permissions?: PermissionRules;
  profiles?: Record<string, string>; // DEPRECATED: old format, kept for migration
  pinnedAgents?: string[]; // Array of agent IDs pinned locally
  memoryReminderInterval?: number | null; // null = disabled, number = overrides global
}

const DEFAULT_SETTINGS: Settings = {
  lastAgent: null,
  tokenStreaming: false,
  enableSleeptime: false,
  sessionContextEnabled: true,
  memoryReminderInterval: 5, // number = prompt memory check every N turns
  globalSharedBlockIds: {},
};

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  localSharedBlockIds: {},
};

const DEFAULT_LOCAL_PROJECT_SETTINGS: LocalProjectSettings = {
  lastAgent: null,
};

class SettingsManager {
  private settings: Settings | null = null;
  private projectSettings: Map<string, ProjectSettings> = new Map();
  private localProjectSettings: Map<string, LocalProjectSettings> = new Map();
  private initialized = false;
  private pendingWrites = new Set<Promise<void>>();
  private secretsAvailable: boolean | null = null;

  /**
   * Initialize the settings manager (loads from disk)
   * Should be called once at app startup
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const settingsPath = this.getSettingsPath();

    try {
      // Check if settings file exists
      if (!exists(settingsPath)) {
        // Create default settings file
        this.settings = { ...DEFAULT_SETTINGS };
        await this.persistSettings();
      } else {
        // Read and parse settings
        const content = await readFile(settingsPath);
        const loadedSettings = JSON.parse(content) as Settings;
        // Merge with defaults in case new fields were added
        this.settings = { ...DEFAULT_SETTINGS, ...loadedSettings };
      }

      this.initialized = true;

      // Check secrets availability and warn if not available
      await this.checkSecretsSupport();

      // Migrate tokens to secrets if they exist in settings
      await this.migrateTokensToSecrets();
    } catch (error) {
      console.error("Error loading settings, using defaults:", error);
      this.settings = { ...DEFAULT_SETTINGS };
      this.initialized = true;

      // Still check secrets support and try to migrate in case of partial failure
      await this.checkSecretsSupport();
      await this.migrateTokensToSecrets();
    }
  }

  /**
   * Check secrets support and warn user if not available
   */
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

  /**
   * Migrate tokens from old storage location to secrets
   */
  private async migrateTokensToSecrets(): Promise<void> {
    if (!this.settings) return;

    try {
      const tokensToMigrate: SecureTokens = {};
      let needsUpdate = false;

      // Check for refresh token in settings
      if (this.settings.refreshToken) {
        tokensToMigrate.refreshToken = this.settings.refreshToken;
        needsUpdate = true;
      }

      // Check for API key in env
      if (this.settings.env?.LETTA_API_KEY) {
        tokensToMigrate.apiKey = this.settings.env.LETTA_API_KEY;
        needsUpdate = true;
      }

      // If we have tokens to migrate, store them in secrets
      if (needsUpdate && Object.keys(tokensToMigrate).length > 0) {
        const available = await this.isKeychainAvailable();
        if (available) {
          try {
            await setSecureTokens(tokensToMigrate);

            // Remove tokens from settings file
            const updatedSettings = { ...this.settings };
            delete updatedSettings.refreshToken;

            if (updatedSettings.env?.LETTA_API_KEY) {
              const { LETTA_API_KEY: _, ...otherEnv } = updatedSettings.env;
              updatedSettings.env =
                Object.keys(otherEnv).length > 0 ? otherEnv : undefined;
            }

            this.settings = updatedSettings;
            await this.persistSettings();

            console.log("Successfully migrated tokens to secrets");
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

  /**
   * Get all settings including secure tokens from secrets (async)
   */
  async getSettingsWithSecureTokens(): Promise<Settings> {
    const baseSettings = this.getSettings();
    let secureTokens: SecureTokens = {};

    // Try to get tokens from secrets first
    const secretsAvailable = await this.isKeychainAvailable();
    if (secretsAvailable) {
      secureTokens = await this.getSecureTokens();
    }

    // Fallback to tokens in settings file if secrets are not available
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

  /**
   * Get a specific setting value (synchronous)
   */
  getSetting<K extends keyof Settings>(key: K): Settings[K] {
    return this.getSettings()[key];
  }

  /**
   * Get or create device ID (generates UUID if not exists)
   */
  getOrCreateDeviceId(): string {
    const settings = this.getSettings();
    let deviceId = settings.deviceId;
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      this.updateSettings({ deviceId });
    }
    return deviceId;
  }

  /**
   * Update settings (synchronous in-memory, async persist)
   */
  updateSettings(updates: Partial<Settings>): void {
    if (!this.initialized || !this.settings) {
      throw new Error(
        "Settings not initialized. Call settingsManager.initialize() first.",
      );
    }

    // Extract secure tokens from updates
    const { env, refreshToken, ...otherUpdates } = updates;
    let apiKey: string | undefined;
    let updatedEnv = env;

    // Check for API key in env updates
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

    // Handle secure tokens in keychain
    const secureTokens: SecureTokens = {};
    if (apiKey) {
      secureTokens.apiKey = apiKey;
    }
    if (refreshToken) {
      secureTokens.refreshToken = refreshToken;
    }

    // Persist both regular settings and secure tokens asynchronously
    const writePromise = this.persistSettingsAndTokens(secureTokens)
      .catch((error) => {
        console.error("Failed to persist settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
  }

  /**
   * Persist settings and tokens, with fallback for secrets unavailability
   */
  private async persistSettingsAndTokens(
    secureTokens: SecureTokens,
  ): Promise<void> {
    const secretsAvailable = await this.isKeychainAvailable();

    if (secretsAvailable && Object.keys(secureTokens).length > 0) {
      // Try to store tokens in secrets, fall back to settings file if it fails
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
        // Continue to fallback logic below
      }
    }

    if (Object.keys(secureTokens).length > 0) {
      // Fallback: store tokens in settings file
      debugWarn(
        "settings",
        "Secrets not available, storing tokens in settings file for persistence",
      );

      // biome-ignore lint/style/noNonNullAssertion: at this point will always exist
      const fallbackSettings: Settings = { ...this.settings! };

      if (secureTokens.refreshToken) {
        fallbackSettings.refreshToken = secureTokens.refreshToken;
      }

      if (secureTokens.apiKey) {
        fallbackSettings.env = {
          ...fallbackSettings.env,
          LETTA_API_KEY: secureTokens.apiKey,
        };
      }

      this.settings = fallbackSettings;
      await this.persistSettings();
    } else {
      // No tokens to store, just persist regular settings
      await this.persistSettings();
    }
  }

  /**
   * Load project settings for a specific directory
   */
  async loadProjectSettings(
    workingDirectory: string = process.cwd(),
  ): Promise<ProjectSettings> {
    // Check cache first
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
        localSharedBlockIds:
          (rawSettings.localSharedBlockIds as Record<string, string>) ?? {},
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

  /**
   * Get project settings (synchronous, from memory)
   */
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

  /**
   * Update project settings (synchronous in-memory, async persist)
   */
  updateProjectSettings(
    updates: Partial<ProjectSettings>,
    workingDirectory: string = process.cwd(),
  ): void {
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
        console.error("Failed to persist project settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
  }

  /**
   * Persist settings to disk (private helper)
   */
  private async persistSettings(): Promise<void> {
    if (!this.settings) return;

    const settingsPath = this.getSettingsPath();
    const home = process.env.HOME || homedir();
    const dirPath = join(home, ".letta");

    try {
      if (!exists(dirPath)) {
        await mkdir(dirPath, { recursive: true });
      }
      await writeFile(settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error("Error saving settings:", error);
      throw error;
    }
  }

  /**
   * Persist project settings to disk (private helper)
   */
  private async persistProjectSettings(
    workingDirectory: string,
  ): Promise<void> {
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

      // Create directory if needed
      if (!exists(dirPath)) {
        await mkdir(dirPath, { recursive: true });
      }

      // Merge updates with existing settings
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
    // Use ~/.letta/ like other AI tools (.claude, .cursor, etc.)
    const home = process.env.HOME || homedir();
    return join(home, ".letta", "settings.json");
  }

  private getProjectSettingsPath(workingDirectory: string): string {
    return join(workingDirectory, ".letta", "settings.json");
  }

  private getLocalProjectSettingsPath(workingDirectory: string): string {
    return join(workingDirectory, ".letta", "settings.local.json");
  }

  /**
   * Load local project settings (.letta/settings.local.json)
   */
  async loadLocalProjectSettings(
    workingDirectory: string = process.cwd(),
  ): Promise<LocalProjectSettings> {
    // Check cache first
    const cached = this.localProjectSettings.get(workingDirectory);
    if (cached) {
      return { ...cached };
    }

    const settingsPath = this.getLocalProjectSettingsPath(workingDirectory);

    try {
      if (!exists(settingsPath)) {
        const defaults = { ...DEFAULT_LOCAL_PROJECT_SETTINGS };
        this.localProjectSettings.set(workingDirectory, defaults);
        return defaults;
      }

      const content = await readFile(settingsPath);
      const localSettings = JSON.parse(content) as LocalProjectSettings;

      this.localProjectSettings.set(workingDirectory, localSettings);
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

  /**
   * Get local project settings (synchronous, from memory)
   */
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

  /**
   * Update local project settings (synchronous in-memory, async persist)
   */
  updateLocalProjectSettings(
    updates: Partial<LocalProjectSettings>,
    workingDirectory: string = process.cwd(),
  ): void {
    const current = this.localProjectSettings.get(workingDirectory);
    if (!current) {
      throw new Error(
        `Local project settings for ${workingDirectory} not loaded. Call loadLocalProjectSettings() first.`,
      );
    }

    const updated = { ...current, ...updates };
    this.localProjectSettings.set(workingDirectory, updated);

    // Persist asynchronously (track promise for testing)
    const writePromise = this.persistLocalProjectSettings(workingDirectory)
      .catch((error) => {
        console.error("Failed to persist local project settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
  }

  /**
   * Persist local project settings to disk (private helper)
   */
  private async persistLocalProjectSettings(
    workingDirectory: string,
  ): Promise<void> {
    const settings = this.localProjectSettings.get(workingDirectory);
    if (!settings) return;

    const settingsPath = this.getLocalProjectSettingsPath(workingDirectory);
    const dirPath = join(workingDirectory, ".letta");

    try {
      // Create directory if needed
      if (!exists(dirPath)) {
        await mkdir(dirPath, { recursive: true });
      }

      await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.error("Error saving local project settings:", error);
      throw error;
    }
  }

  // =====================================================================
  // Session Management Helpers
  // =====================================================================

  /**
   * Get the last session from global settings.
   * Migrates from lastAgent if lastSession is not set.
   * Returns null if no session is available.
   */
  getGlobalLastSession(): SessionRef | null {
    const settings = this.getSettings();
    if (settings.lastSession) {
      return settings.lastSession;
    }
    // Migration: if lastAgent exists but lastSession doesn't, return null
    // (caller will need to create a new conversation for this agent)
    return null;
  }

  /**
   * Get the last agent ID from global settings (for migration purposes).
   * Returns the agentId from lastSession if available, otherwise falls back to lastAgent.
   */
  getGlobalLastAgentId(): string | null {
    const settings = this.getSettings();
    if (settings.lastSession) {
      return settings.lastSession.agentId;
    }
    return settings.lastAgent;
  }

  /**
   * Set the last session in global settings.
   */
  setGlobalLastSession(session: SessionRef): void {
    this.updateSettings({ lastSession: session, lastAgent: session.agentId });
  }

  /**
   * Get the last session from local project settings.
   * Migrates from lastAgent if lastSession is not set.
   * Returns null if no session is available.
   */
  getLocalLastSession(
    workingDirectory: string = process.cwd(),
  ): SessionRef | null {
    const localSettings = this.getLocalProjectSettings(workingDirectory);
    if (localSettings.lastSession) {
      return localSettings.lastSession;
    }
    // Migration: if lastAgent exists but lastSession doesn't, return null
    // (caller will need to create a new conversation for this agent)
    return null;
  }

  /**
   * Get the last agent ID from local project settings (for migration purposes).
   * Returns the agentId from lastSession if available, otherwise falls back to lastAgent.
   */
  getLocalLastAgentId(workingDirectory: string = process.cwd()): string | null {
    const localSettings = this.getLocalProjectSettings(workingDirectory);
    if (localSettings.lastSession) {
      return localSettings.lastSession.agentId;
    }
    return localSettings.lastAgent;
  }

  /**
   * Set the last session in local project settings.
   */
  setLocalLastSession(
    session: SessionRef,
    workingDirectory: string = process.cwd(),
  ): void {
    this.updateLocalProjectSettings(
      { lastSession: session, lastAgent: session.agentId },
      workingDirectory,
    );
  }

  /**
   * Get the effective last session (local overrides global).
   * Returns null if no session is available anywhere.
   */
  getEffectiveLastSession(
    workingDirectory: string = process.cwd(),
  ): SessionRef | null {
    // Check local first
    const localSession = this.getLocalLastSession(workingDirectory);
    if (localSession) {
      return localSession;
    }
    // Fall back to global
    return this.getGlobalLastSession();
  }

  /**
   * Get the effective last agent ID (local overrides global).
   * Useful for migration when we need an agent but don't have a conversation yet.
   */
  getEffectiveLastAgentId(
    workingDirectory: string = process.cwd(),
  ): string | null {
    // Check local first
    const localAgentId = this.getLocalLastAgentId(workingDirectory);
    if (localAgentId) {
      return localAgentId;
    }
    // Fall back to global
    return this.getGlobalLastAgentId();
  }

  // =====================================================================
  // Profile Management Helpers
  // =====================================================================

  /**
   * Get globally pinned agent IDs from ~/.letta/settings.json
   * Migrates from old profiles format if needed.
   */
  getGlobalPinnedAgents(): string[] {
    const settings = this.getSettings();
    // Migrate from old format if needed
    if (settings.profiles && !settings.pinnedAgents) {
      const agentIds = Object.values(settings.profiles);
      this.updateSettings({ pinnedAgents: agentIds, profiles: undefined });
      return agentIds;
    }
    return settings.pinnedAgents || [];
  }

  /**
   * Get locally pinned agent IDs from .letta/settings.local.json
   * Migrates from old profiles format if needed.
   */
  getLocalPinnedAgents(workingDirectory: string = process.cwd()): string[] {
    const localSettings = this.getLocalProjectSettings(workingDirectory);
    // Migrate from old format if needed
    if (localSettings.profiles && !localSettings.pinnedAgents) {
      const agentIds = Object.values(localSettings.profiles);
      this.updateLocalProjectSettings(
        { pinnedAgents: agentIds, profiles: undefined },
        workingDirectory,
      );
      return agentIds;
    }
    return localSettings.pinnedAgents || [];
  }

  /**
   * Get merged pinned agents (local + global), deduped.
   * Returns array of { agentId, isLocal }.
   */
  getMergedPinnedAgents(
    workingDirectory: string = process.cwd(),
  ): Array<{ agentId: string; isLocal: boolean }> {
    const globalAgents = this.getGlobalPinnedAgents();
    const localAgents = this.getLocalPinnedAgents(workingDirectory);

    const result: Array<{ agentId: string; isLocal: boolean }> = [];
    const seenAgentIds = new Set<string>();

    // Add local agents first (they take precedence)
    for (const agentId of localAgents) {
      result.push({ agentId, isLocal: true });
      seenAgentIds.add(agentId);
    }

    // Add global agents that aren't also local
    for (const agentId of globalAgents) {
      if (!seenAgentIds.has(agentId)) {
        result.push({ agentId, isLocal: false });
        seenAgentIds.add(agentId);
      }
    }

    return result;
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
    workingDirectory: string = process.cwd(),
  ): Array<{ name: string; agentId: string; isLocal: boolean }> {
    const merged = this.getMergedPinnedAgents(workingDirectory);
    return merged.map(({ agentId, isLocal }) => ({
      name: "", // Name will be fetched from server
      agentId,
      isLocal,
    }));
  }

  /**
   * Pin an agent to both local AND global settings
   */
  pinBoth(agentId: string, workingDirectory: string = process.cwd()): void {
    // Update global
    const globalAgents = this.getGlobalPinnedAgents();
    if (!globalAgents.includes(agentId)) {
      this.updateSettings({ pinnedAgents: [...globalAgents, agentId] });
    }

    // Update local
    const localAgents = this.getLocalPinnedAgents(workingDirectory);
    if (!localAgents.includes(agentId)) {
      this.updateLocalProjectSettings(
        { pinnedAgents: [...localAgents, agentId] },
        workingDirectory,
      );
    }
  }

  // DEPRECATED: Keep for backwards compatibility
  saveProfile(
    _name: string,
    agentId: string,
    workingDirectory: string = process.cwd(),
  ): void {
    this.pinBoth(agentId, workingDirectory);
  }

  /**
   * Pin an agent locally (to this project)
   */
  pinLocal(agentId: string, workingDirectory: string = process.cwd()): void {
    const localAgents = this.getLocalPinnedAgents(workingDirectory);
    if (!localAgents.includes(agentId)) {
      this.updateLocalProjectSettings(
        { pinnedAgents: [...localAgents, agentId] },
        workingDirectory,
      );
    }
  }

  /**
   * Unpin an agent locally (from this project only)
   */
  unpinLocal(agentId: string, workingDirectory: string = process.cwd()): void {
    const localAgents = this.getLocalPinnedAgents(workingDirectory);
    this.updateLocalProjectSettings(
      { pinnedAgents: localAgents.filter((id) => id !== agentId) },
      workingDirectory,
    );
  }

  /**
   * Check if default agents (Memo/Incognito) should be created on startup.
   * Defaults to true if not explicitly set to false.
   */
  shouldCreateDefaultAgents(): boolean {
    const settings = this.getSettings();
    return settings.createDefaultAgents !== false;
  }

  /**
   * Pin an agent globally
   */
  pinGlobal(agentId: string): void {
    const globalAgents = this.getGlobalPinnedAgents();
    if (!globalAgents.includes(agentId)) {
      this.updateSettings({ pinnedAgents: [...globalAgents, agentId] });
    }
  }

  /**
   * Unpin an agent globally
   */
  unpinGlobal(agentId: string): void {
    const globalAgents = this.getGlobalPinnedAgents();
    this.updateSettings({
      pinnedAgents: globalAgents.filter((id) => id !== agentId),
    });
  }

  /**
   * Unpin an agent from both local and global settings
   */
  unpinBoth(agentId: string, workingDirectory: string = process.cwd()): void {
    this.unpinLocal(agentId, workingDirectory);
    this.unpinGlobal(agentId);
  }

  // DEPRECATED: Keep for backwards compatibility
  deleteProfile(
    _name: string,
    _workingDirectory: string = process.cwd(),
  ): void {
    // This no longer makes sense with the new model
    // Would need an agentId to unpin
    console.warn("deleteProfile is deprecated, use unpinBoth(agentId) instead");
  }

  // DEPRECATED: Keep for backwards compatibility
  pinProfile(
    _name: string,
    agentId: string,
    workingDirectory: string = process.cwd(),
  ): void {
    this.pinLocal(agentId, workingDirectory);
  }

  // DEPRECATED: Keep for backwards compatibility
  unpinProfile(_name: string, _workingDirectory: string = process.cwd()): void {
    // This no longer makes sense with the new model
    console.warn("unpinProfile is deprecated, use unpinLocal(agentId) instead");
  }

  /**
   * Check if local .letta directory exists (indicates existing project)
   */
  hasLocalLettaDir(workingDirectory: string = process.cwd()): boolean {
    const dirPath = join(workingDirectory, ".letta");
    return exists(dirPath);
  }

  /**
   * Store OAuth state for pending authorization
   */
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

  /**
   * Get pending OAuth state
   */
  getOAuthState(): Settings["oauthState"] | null {
    const settings = this.getSettings();
    return settings.oauthState || null;
  }

  /**
   * Clear pending OAuth state
   */
  clearOAuthState(): void {
    const settings = this.getSettings();
    const { oauthState: _, ...rest } = settings;
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
    this.persistSettings().catch((error) => {
      console.error(
        "Failed to persist settings after clearing OAuth state:",
        error,
      );
    });
  }

  /**
   * Check if secrets are available
   */
  async isKeychainAvailable(): Promise<boolean> {
    if (this.secretsAvailable === null) {
      this.secretsAvailable = await isKeychainAvailable();
    }
    return this.secretsAvailable;
  }

  /**
   * Get secure tokens from secrets
   */
  async getSecureTokens(): Promise<SecureTokens> {
    const available = await this.isKeychainAvailable();
    if (!available) {
      return {};
    }

    try {
      return await getSecureTokens();
    } catch (error) {
      console.warn("Failed to retrieve tokens from secrets:", error);
      return {};
    }
  }

  /**
   * Store secure tokens in secrets
   */
  async setSecureTokens(tokens: SecureTokens): Promise<void> {
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
      console.warn(
        "Failed to store tokens in secrets, falling back to settings file",
      );
      // Let the caller handle the fallback by throwing again
      throw error;
    }
  }

  /**
   * Delete secure tokens from secrets
   */
  async deleteSecureTokens(): Promise<void> {
    const available = await this.isKeychainAvailable();
    if (!available) {
      return;
    }

    try {
      await deleteSecureTokens();
    } catch (error) {
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

  /**
   * Logout - clear all tokens and sensitive authentication data
   */
  async logout(): Promise<void> {
    try {
      // Clear tokens from secrets
      await this.deleteSecureTokens();

      // Clear token-related settings from in-memory settings
      if (this.settings) {
        const updatedSettings = { ...this.settings };
        delete updatedSettings.refreshToken;
        delete updatedSettings.tokenExpiresAt;
        delete updatedSettings.deviceId;

        // Clear API key from env if present
        if (updatedSettings.env?.LETTA_API_KEY) {
          const { LETTA_API_KEY: _, ...otherEnv } = updatedSettings.env;
          updatedSettings.env =
            Object.keys(otherEnv).length > 0 ? otherEnv : undefined;
        }

        this.settings = updatedSettings;
        await this.persistSettings();
      }

      console.log(
        "Successfully logged out and cleared all authentication data",
      );
    } catch (error) {
      console.error("Error during logout:", error);
      throw error;
    }
  }

  /**
   * Reset the manager (mainly for testing).
   * Waits for pending writes to complete before resetting.
   */
  async reset(): Promise<void> {
    // Wait for pending writes BEFORE clearing state
    await this.flush();

    this.settings = null;
    this.projectSettings.clear();
    this.localProjectSettings.clear();
    this.initialized = false;
    this.pendingWrites.clear();
    this.secretsAvailable = null;
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
