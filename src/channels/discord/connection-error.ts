// Translates low-level Discord gateway connection failures into clear,
// actionable messages for the bot setup UI. Kept dependency-free so the
// detection logic can be unit-tested without the discord.js runtime.

/**
 * Shown when Discord rejects the gateway connection because a privileged
 * intent (here: Message Content) is not enabled for the application. Discord
 * surfaces this as the opaque close reason "Used disallowed intents"
 * (gateway close code 4014), which gives the user no idea how to fix it.
 */
export const DISCORD_DISALLOWED_INTENTS_MESSAGE =
  'Discord rejected the connection because this bot needs the privileged "Message Content" intent, which is not enabled for its application.\n\n' +
  "Enable it in the Discord Developer Portal:\n" +
  "1. Open https://discord.com/developers/applications and select this bot's application.\n" +
  "2. Go to Bot → Privileged Gateway Intents.\n" +
  '3. Turn on "Message Content Intent" and save.\n' +
  "4. Reconnect the bot here.\n\n" +
  "Letta Code uses the Message Content intent to read message text in open channels. (Replying to @mentions and direct messages works without it.)";

function extractErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function extractErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      return String(code);
    }
  }
  return "";
}

/**
 * Returns true when an error raised while connecting a Discord bot indicates
 * that the requested privileged gateway intents are not enabled.
 *
 * Matches the several shapes discord.js / the gateway can use:
 * - close code `4014`
 * - discord.js error code `"DisallowedIntents"`
 * - messages mentioning "disallowed intent(s)" or "privileged intent".
 */
export function isDiscordDisallowedIntentsError(error: unknown): boolean {
  const haystack =
    `${extractErrorCode(error)} ${extractErrorText(error)}`.toLowerCase();
  if (!haystack.trim()) return false;
  return (
    haystack.includes("4014") ||
    haystack.includes("disallowedintents") ||
    haystack.includes("disallowed intent") ||
    haystack.includes("privileged intent")
  );
}

/**
 * Map a Discord connection error to a user-facing message when it is a known,
 * actionable failure. Returns `null` for unrecognized errors so callers can
 * fall back to the original error.
 */
export function describeDiscordConnectionError(error: unknown): string | null {
  if (isDiscordDisallowedIntentsError(error)) {
    return DISCORD_DISALLOWED_INTENTS_MESSAGE;
  }
  return null;
}
