/**
 * Package export: `@letta-ai/letta-code/agent-presets`
 *
 * Browser-safe library entry exposing Letta Code's agent creation presets so
 * other surfaces (e.g. the chat web app) can create Letta Code agents through
 * Core with byte-identical payloads to the CLI — personalities, memory block
 * content, system prompts, tags, and the create-agent request builder.
 *
 * Everything reachable from this module must stay free of Node builtins and
 * backend/provider imports; it is bundled with `target: "browser"`.
 */

export {
  type BuildCreatedAgentTagsOptions,
  buildCreatedAgentTags,
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
  LETTA_CODE_SUBAGENT_TAG,
} from "./agent/agent-tags";
export {
  buildCreateAgentRequestForPersonality,
  type CreateAgentRequestForPersonality,
  DEFAULT_CREATED_AGENT_BASE_TOOLS,
  LETTA_CODE_AGENT_TYPE,
} from "./agent/create-agent-request";
export {
  DEFAULT_CREATE_AGENT_PERSONALITIES,
  type DefaultCreateAgentPersonalityId,
  getPersonalityOption,
  PERSONALITY_OPTIONS,
  type PersonalityId,
  type PersonalityMemoryBlock,
  type PersonalityOption,
  resolvePersonalityId,
} from "./agent/personality-presets";
export {
  buildSystemPrompt,
  type MemoryPromptMode,
} from "./agent/prompt-assets";
