// src/permissions/session.ts
// In-memory permission store for session-only rules

import type { PermissionRules, PermissionRuleType } from "./types";

/**
 * Session-only permissions that are not persisted to disk.
 * These rules are cleared when the application exits.
 */
class SessionPermissions {
  private sessionRules: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    alwaysAsk: [],
  };

  /**
   * Add a permission rule for this session only
   */
  addRule(rule: string, type: PermissionRuleType): void {
    const rules = this.sessionRules[type];
    if (rules && !rules.includes(rule)) {
      rules.push(rule);
    }
  }

  /**
   * Get all session rules
   */
  getRules(): PermissionRules {
    return {
      allow: [...(this.sessionRules.allow || [])],
      deny: [...(this.sessionRules.deny || [])],
      ask: [...(this.sessionRules.ask || [])],
      alwaysAsk: [...(this.sessionRules.alwaysAsk || [])],
    };
  }

  /**
   * Clear all session rules
   */
  clear(): void {
    this.sessionRules = {
      allow: [],
      deny: [],
      ask: [],
      alwaysAsk: [],
    };
  }

  /**
   * Check if a rule exists in session permissions
   */
  hasRule(rule: string, type: PermissionRuleType): boolean {
    return this.sessionRules[type]?.includes(rule) || false;
  }
}

// Singleton instance
export const sessionPermissions = new SessionPermissions();
