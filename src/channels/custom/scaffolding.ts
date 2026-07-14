import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChannelDir } from "@/channels/config";
import { FIRST_PARTY_CHANNEL_IDS } from "@/channels/types";

// ── Slugification ─────────────────────────────────────────────────────────────

/**
 * Convert a user-supplied display name into a valid channel ID.
 *
 * Rules:
 *  - lowercase
 *  - runs of non-alphanumeric chars collapsed to a single hyphen
 *  - leading/trailing hyphens stripped
 *  - max 40 characters
 *  - must be at least 2 characters (pad with "app" if needed)
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  if (slug.length === 0) return "custom-app";
  if (slug.length === 1) return `${slug}-app`;
  return slug;
}

// ── Stub plugin.mjs template ──────────────────────────────────────────────────

function buildStubPlugin(id: string, displayName: string): string {
  // Self-contained webhook forwarder — no imports from letta-code.
  // Mirrors the logic in src/channels/custom/adapter.ts.
  return `/**
 * Auto-generated webhook channel plugin for Letta Code.
 * Channel: ${displayName} (${id})
 *
 * This plugin forwards outbound agent messages to the configured webhook URL.
 * Edit freely — changes take effect on the next listener restart.
 *
 * config keys (set via the Desktop UI):
 *   url        — webhook endpoint (required)
 *   bot_token  — sent as Authorization: Bearer <token>
 *   auth       — sent as X-Letta-Auth: <value>
 */

function readStr(config, key) {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function extractMessageId(body) {
  if (!body || typeof body !== 'object') return null;
  const id = body.message_id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

export const channelPlugin = {
  metadata: {
    id: ${JSON.stringify(id)},
    displayName: ${JSON.stringify(displayName)},
    runtimePackages: [],
    runtimeModules: [],
  },

  createAdapter(account) {
    const config = account.config ?? {};
    let running = false;

    async function deliver(msg) {
      const url = readStr(config, 'url');
      if (!url) {
        throw new Error(\`[\${account.displayName ?? ${JSON.stringify(id)}}] No webhook URL configured.\`);
      }

      const headers = { 'Content-Type': 'application/json' };
      const token = readStr(config, 'bot_token');
      if (token) headers['Authorization'] = \`Bearer \${token}\`;
      const auth = readStr(config, 'auth');
      if (auth) headers['X-Letta-Auth'] = auth;

      const body = JSON.stringify({
        channel: ${JSON.stringify(id)},
        account_id: msg.accountId ?? account.accountId,
        chat_id: msg.chatId,
        text: msg.text,
        reply_to_message_id: msg.replyToMessageId ?? null,
        thread_id: msg.threadId ?? null,
      });

      const res = await fetch(url, { method: 'POST', headers, body });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(\`Webhook \${url} returned \${res.status}\${detail ? \`: \${detail}\` : ''}\`);
      }

      let parsed = null;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try { parsed = await res.json(); } catch {}
      }

      return { messageId: extractMessageId(parsed) ?? crypto.randomUUID() };
    }

    return {
      id: \`${id}:\${account.accountId}\`,
      channelId: ${JSON.stringify(id)},
      accountId: account.accountId,
      name: account.displayName ?? ${JSON.stringify(displayName)},

      async start() { running = true; },
      async stop()  { running = false; },
      isRunning()   { return running; },

      async sendMessage(msg) {
        return deliver(msg);
      },

      async sendDirectReply(chatId, text, options) {
        await deliver({
          channel: ${JSON.stringify(id)},
          accountId: account.accountId,
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
    };
  },
};
`;
}

// ── Public API ────────────────────────────────────────────────────────────────

const FIRST_PARTY_SET = new Set<string>(FIRST_PARTY_CHANNEL_IDS);
let removeUserPluginOverride: ((channelId: string) => void) | null = null;

/**
 * Creates `~/.letta/channels/<slug>/channel.json` and a stub `plugin.mjs`.
 *
 * Throws if:
 *  - The slug is already taken by an existing folder (name must be unique)
 *  - The slug collides with a first-party channel ID
 *
 * Returns the generated channel ID.
 */
export function scaffoldUserPlugin(displayName: string): string {
  const id = slugify(displayName);

  if (FIRST_PARTY_SET.has(id)) {
    throw new Error(
      `"${displayName}" conflicts with a built-in channel name. Please choose a different name.`,
    );
  }

  const channelDir = getChannelDir(id);
  if (existsSync(channelDir)) {
    throw new Error(
      `A custom app named "${displayName}" already exists. Please choose a unique name.`,
    );
  }

  mkdirSync(channelDir, { recursive: true });

  const manifest = {
    id,
    displayName,
    entry: "./plugin.mjs",
    runtimePackages: [],
    runtimeModules: [],
  };
  writeFileSync(
    join(channelDir, "channel.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  writeFileSync(
    join(channelDir, "plugin.mjs"),
    buildStubPlugin(id, displayName),
    "utf-8",
  );

  return id;
}

/**
 * Removes the plugin folder for a user-created channel.
 * Safe to call even if the folder doesn't exist.
 * No-op for first-party channels.
 */
export function removeUserPlugin(channelId: string): void {
  if (removeUserPluginOverride) {
    removeUserPluginOverride(channelId);
    return;
  }

  if (FIRST_PARTY_SET.has(channelId)) {
    return;
  }
  // Reject channel IDs that could escape the channels root via path traversal.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(channelId)) {
    return;
  }
  const channelDir = getChannelDir(channelId);
  if (!existsSync(channelDir)) {
    return;
  }
  try {
    rmSync(channelDir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[channels] Failed to remove plugin folder ${channelDir}:`,
      err,
    );
  }
}

export function removeUserPluginBestEffort(channelId: string): void {
  try {
    removeUserPlugin(channelId);
  } catch (error) {
    console.warn(`[channels] failed to remove user plugin ${channelId}`, error);
  }
}

export function __testOverrideRemoveUserPlugin(
  fn: ((channelId: string) => void) | null,
): void {
  removeUserPluginOverride = fn;
}
