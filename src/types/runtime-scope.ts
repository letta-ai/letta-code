/**
 * Runtime identity for all state and delta events.
 *
 * `acting_user_id` is set by cloud-api on inbound `input`
 * create_message frames (the WS subscriber's authenticated cloud
 * user id). The listener echoes it back as the
 * `X-Letta-Acting-User-Id` HTTP header on the outbound
 * createMessage call so cloud can attribute credits + rate limits
 * to the actual sender — not the user whose API key happens to
 * spawn the sandbox / desktop runtime. Other event types (state,
 * delta, control) ignore this field.
 */
export interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
  acting_user_id?: string;
}
