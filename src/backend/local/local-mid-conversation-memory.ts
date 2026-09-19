import type { LocalAgentRecord } from "./local-types";

// Providers that accept a `role: "system"` message appended after a user turn,
// AND whose transport in pi-stream-adapter appends it. Both halves matter: if
// the backend emits a mid-conversation update that the transport never sends,
// the model silently runs on stale memory until the next full recompilation.
//
// - Anthropic documents it for Opus 4.8, Opus 5, Fable 5/5.1 and Mythos 5/5.1,
//   explicitly as the way to update instructions without invalidating the
//   cached prefix (transport: anthropic-messages).
// - OpenAI-compatible chat completions treat system messages as ordinary
//   entries in the message list; in pi-ai, deepseek and zai use that API
//   (transport: openai-completions).
// - xai (openai-responses) and openai-codex (openai-codex-responses) are NOT
//   included: their transports do not append the update yet.
// Everything else keeps the previous behaviour: full recompilation.
// Exact ids from the Anthropic docs ("Using the Messages API", 2026-09).
// Keep this an allowlist: a prefix match would silently opt in future
// variants whose support is unknown.
const MID_CONVERSATION_SYSTEM_ANTHROPIC_MODELS = new Set([
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5",
  "claude-mythos-5-1",
]);

export function supportsMidConversationSystemMessages(
  agent: LocalAgentRecord,
): boolean {
  const model = agent.model ?? "";
  const slash = model.indexOf("/");
  const provider = slash >= 0 ? model.slice(0, slash) : "";
  const id = slash >= 0 ? model.slice(slash + 1) : model;
  if (provider === "anthropic") {
    return MID_CONVERSATION_SYSTEM_ANTHROPIC_MODELS.has(id);
  }
  return provider === "deepseek" || provider === "zai";
}
