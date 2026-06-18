/**
 * Helpers for sanitizing conversation create/update request bodies before
 * they are forwarded to the backend API.
 */

import type { BackendCapabilities } from "@/backend";

/**
 * Strips fields from a conversation create body that are accepted by the
 * TS client SDK types but rejected by the cloud API endpoint.
 *
 * Specifically, `model_settings` is advertised in `ConversationCreateParams`
 * (letta-client 1.10.2) but the live `POST /v1/conversations/` endpoint
 * returns 500 when it is present. The local backend stores and uses
 * `model_settings` on conversations for per-conversation model overrides, so
 * we only strip it on the cloud path.
 */
export function sanitizeConversationCreateBody(
  body: Record<string, unknown>,
  capabilities: Pick<BackendCapabilities, "localMemfs">,
): Record<string, unknown> {
  if (capabilities.localMemfs) {
    return body;
  }
  if (!Object.hasOwn(body, "model_settings")) {
    return body;
  }
  const { model_settings: _stripped, ...rest } = body;
  return rest;
}
