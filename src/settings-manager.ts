// src/settings-manager.ts
// In-memory settings manager that loads once and provides sync access

import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRules } from "./permissions/types";
import { exists, mkdir, readFile, writeFile } from "./utils/fs.js";

export interface Settings {
  lastAgent: string | null;
  tokenStreaming: boolean;
  enableSleeptime: boolean;
  sessionContextEnabled: boolean; // Send device/agent context on first message of each session
  globalSharedBlockIds: Record<string, string>; // DEPRECATED: kept for backwards compat
  profiles?: Record<string, string>; // DEPRECATED: old format, kept for migration
  pinnedAgents?: string[]; // Array of agent IDs pinned globally
  permissions?: PermissionRules;
  env?: Record<string, string>;
  // Letta Cloud OAuth token management
  refreshToken?: string;
  tokenExpiresAt?: number; // Unix timestamp in milliseconds
  deviceId?: string;
  // Tool upsert cache: maps serverUrl -> hash of upserted tools
  toolUpsertHashes?: Record<string, string>;
  // Anthropic OAuth
  anthropicOAuth?: {
    access_token: string;
    refresh_token?: string;
    expires_at: number; // Unix timestamp in milliseconds
    scope?: string;
  };
  // Pending OAuth state (for PKCE flow)
  oauthState?: {
    state: string;
    codeVerifier: string;
    provider: "anthropic";
    timestamp: number;
  };
}

export interface ProjectSettings {
  localSharedBlockIds: Record<string, string>;
}

export interface LocalProjectSettings {
  lastAgent: string | null;
  permissions?: PermissionRules;
  profiles?: Record<string, string>; // DEPRECATED: old format, kept for migration
  pinnedAgents?: string[]; // Array of agent IDs pinned locally
}

const DEFAULT_SETTINGS: Settings = {
  lastAgent: null,
  tokenStreaming: false,
  enableSleeptime: false,
  sessionContextEnabled: true,
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
    } catch (error) {
      console.error("Error loading settings, using defaults:", error);
      this.settings = { ...DEFAULT_SETTINGS };
      this.initialized = true;
    }
  }

  /**
   * Get all settings (synchronous, from memory)
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
   * Get a specific setting value (synchronous)
   */
  getSetting<K extends keyof Settings>(key: K): Settings[K] {
    return this.getSettings()[key];
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

    this.settings = { ...this.settings, ...updates };

    // Persist asynchronously (track promise for testing)
    const writePromise = this.persistSettings()
      .catch((error) => {
        console.error("Failed to persist settings:", error);
      })
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      });
    this.pendingWrites.add(writePromise);
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
    // Respect process.env.HOME for testing (homedir() ignores it)
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

  // =====================================================================
  // Anthropic OAuth Management
  // =====================================================================

  /**
   * Store Anthropic OAuth tokens
   */
  storeAnthropicTokens(tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  }): void {
    this.updateSettings({
      anthropicOAuth: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scope: tokens.scope,
      },
    });
  }

  /**
   * Get Anthropic OAuth tokens (returns null if not set or expired)
   */
  getAnthropicTokens(): Settings["anthropicOAuth"] | null {
    const settings = this.getSettings();
    if (!settings.anthropicOAuth) return null;
    return settings.anthropicOAuth;
  }

  /**
   * Check if Anthropic OAuth tokens are expired or about to expire
   * Returns true if token expires within the next 5 minutes
   */
  isAnthropicTokenExpired(): boolean {
    const tokens = this.getAnthropicTokens();
    if (!tokens) return true;

    const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
    return tokens.expires_at < fiveMinutesFromNow;
  }

  /**
   * Check if Anthropic OAuth is configured
   */
  hasAnthropicOAuth(): boolean {
    return !!this.getAnthropicTokens();
  }

  /**
   * Clear Anthropic OAuth tokens and state
   */
  clearAnthropicOAuth(): void {
    const settings = this.getSettings();
    const { anthropicOAuth: _, oauthState: __, ...rest } = settings;
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
    this.persistSettings().catch((error) => {
      console.error("Failed to persist settings after clearing Anthropic OAuth:", error);
    });
  }

  /**
   * Store OAuth state for pending authorization
   */
  storeOAuthState(state: string, codeVerifier: string, provider: "anthropic"): void {
    this.updateSettings({
      oauthState: {
        state,
        codeVerifier,
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
      console.error("Failed to persist settings after clearing OAuth state:", error);
    });
  }

  /**
   * Wait for all pending writes to complete.
   * Useful in tests to ensure writes finish before cleanup.
   */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.pendingWrites));
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
