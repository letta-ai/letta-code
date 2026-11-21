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

  addRule(rule: string, type: PermissionRuleType): void {
    const rules = this.sessionRules[type];
    if (rules && !rules.includes(rule)) {
      rules.push(rule);
    }
  }

  getRules(): PermissionRules {
    return {
      allow: [...(this.sessionRules.allow || [])],
      deny: [...(this.sessionRules.deny || [])],
      ask: [...(this.sessionRules.ask || [])],
      alwaysAsk: [...(this.sessionRules.alwaysAsk || [])],
    };
  }

  clear(): void {
    this.sessionRules = {
      allow: [],
      deny: [],
      ask: [],
      alwaysAsk: [],
    };
  }

  hasRule(rule: string, type: PermissionRuleType): boolean {
    return this.sessionRules[type]?.includes(rule) || false;
  }
}

export const sessionPermissions = new SessionPermissions();
