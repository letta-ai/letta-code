import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import type {
  FeishuChannelAccount,
  FeishuDomain,
  FeishuGroupMode,
} from "@/channels/types";

const FEISHU_CONFIG_KEYS = new Set([
  "app_id",
  "app_secret",
  "domain",
  "group_mode",
  "agent_id",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFeishuDomain(value: unknown): value is FeishuDomain {
  return value === "feishu" || value === "lark";
}

function isFeishuGroupMode(value: unknown): value is FeishuGroupMode {
  return value === "open" || value === "mention-only";
}

export const feishuAccountConfigAdapter: ChannelAccountConfigAdapter<FeishuChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!FEISHU_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.app_id === undefined || isString(config.app_id)) &&
        (config.app_secret === undefined || isString(config.app_secret)) &&
        (config.domain === undefined || isFeishuDomain(config.domain)) &&
        (config.group_mode === undefined ||
          isFeishuGroupMode(config.group_mode)) &&
        (config.agent_id === undefined || isNullableString(config.agent_id))
      );
    },

    toAccountPatch(config) {
      return {
        appId: isString(config.app_id) ? config.app_id : undefined,
        appSecret: isString(config.app_secret) ? config.app_secret : undefined,
        domain: isFeishuDomain(config.domain) ? config.domain : undefined,
        groupMode: isFeishuGroupMode(config.group_mode)
          ? config.group_mode
          : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        has_app_secret: account.appSecret.trim().length > 0,
        app_id: account.appId,
        domain: account.domain,
        group_mode: account.groupMode,
        agent_id: account.agentId,
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_app_secret: account.appSecret.trim().length > 0,
        app_id: account.appId,
        domain: account.domain,
        group_mode: account.groupMode,
        agent_id: account.agentId,
      };
    },

    shouldRefreshDisplayName(patch) {
      return (
        patch.appId !== undefined ||
        patch.appSecret !== undefined ||
        patch.domain !== undefined
      );
    },
  };
