import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";

/** Core client-skill metadata accepted as trusted request-scoped prompt data. */
export type RequestScopedClientSkill = NonNullable<
  MessageCreateParams["client_skills"]
>[number];

/** Trusted controller-supplied shell secrets scoped to one listener turn. */
export type RequestScopedSecretEnv = Record<string, string>;
