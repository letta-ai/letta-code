# Scheduled iMessage Conversation Continuity

For scheduled iMessage outreach, resolve and schedule the exact paired route in
one guarded shell call. This prevents a failed request from becoming an empty
but apparently successful route and keeps shell-local values available while
the prompt is constructed. Select by the current conversation and require
exactly one paired route; do not copy phone-derived fields from the response.
Encode the exact message, schedule name, and description as Base64 **outside the
shell command**, then replace only the three Base64 placeholders and the schedule
flag below. Never paste raw external text into shell source: `$`, quotes,
backticks, command substitutions, backslashes, and multiline content must remain
data rather than becoming Bash syntax.

```bash
set -euo pipefail

message_b64="<base64 of exact UTF-8 message>"
schedule_name_b64="<base64 of short name>"
schedule_description_b64="<base64 of description>"
agent_id="${AGENT_ID:-${LETTA_AGENT_ID:?missing agent ID}}"
current_conversation_id="${CONVERSATION_ID:-${LETTA_CONVERSATION_ID:?missing conversation ID}}"

connections_json="$(curl -fsS \
  "$LETTA_BASE_URL/v1/agents/$agent_id/imessage/connection" \
  -H "Authorization: Bearer $LETTA_API_KEY")"
if [[ -z "${connections_json//[[:space:]]/}" ]]; then
  echo "iMessage route lookup returned an empty response" >&2
  exit 1
fi

route_json="$(jq -cer \
  --arg conversation_id "$current_conversation_id" '
  if type != "object" or (.connections | type) != "array" then
    error("invalid iMessage route response")
  else
    [.connections[] |
      select(
        .conversation_id == $conversation_id and .status == "paired"
      ) |
      {id, conversation_id, integration_id}] |
    if length == 1 then .[0]
    else error("expected exactly one paired route for this conversation") end
  end
' <<<"$connections_json")"
unset connections_json
if [[ -z "${route_json//[[:space:]]/}" ]]; then
  echo "iMessage route projection was empty" >&2
  exit 1
fi

target_route_id="$(jq -er '.id | select(type == "string" and length > 0)' <<<"$route_json")"
target_conversation_id="$(jq -er '.conversation_id | select(type == "string" and length > 0)' <<<"$route_json")"
target_account_id="$(jq -er '.integration_id | select(type == "string" and length > 0)' <<<"$route_json")"
if [[ -z "$target_route_id" || -z "$target_conversation_id" || -z "$target_account_id" ]]; then
  echo "iMessage route contains an empty required field" >&2
  exit 1
fi
decoded_fields_json="$(node - \
  "$message_b64" \
  "$schedule_name_b64" \
  "$schedule_description_b64" \
  "$target_route_id" \
  "$target_account_id" <<'NODE'
const [messageBase64, nameBase64, descriptionBase64, routeId, accountId] =
  process.argv.slice(2);
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decode(label, value) {
  if (!base64Pattern.test(value)) throw new Error(`${label} is not valid padded Base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical Base64`);
  const text = utf8.decode(bytes);
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${label} changed during UTF-8 decoding`);
  if (text.length === 0) throw new Error(`${label} must be non-empty`);
  if (text.includes("\0")) throw new Error(`${label} must not contain NUL`);
  return text;
}
const message = decode("message", messageBase64);
const scheduleName = decode("schedule name", nameBase64);
const scheduleDescription = decode("schedule description", descriptionBase64);
process.stdout.write(JSON.stringify({
  scheduleName,
  scheduleDescription,
  messageChannelArgs: {
    action: "send",
    channel: "imessage",
    chat_id: routeId,
    accountId,
    message,
  },
}));
NODE
)"
schedule_name="$(jq -er '.scheduleName | select(type == "string" and length > 0)' <<<"$decoded_fields_json")"
schedule_description="$(jq -er '.scheduleDescription | select(type == "string" and length > 0)' <<<"$decoded_fields_json")"
message_channel_args="$(jq -cer '.messageChannelArgs' <<<"$decoded_fields_json")"
unset decoded_fields_json
prompt="When this schedule fires, call MessageChannel exactly once with these exact arguments: $message_channel_args. Do not only reply in the conversation."

inspect_ambiguous_schedules() {
  local runner list_json list_status
  for runner in local cloud; do
    set +e
    list_json="$(letta cron list \
      --runner "$runner" \
      --agent "$agent_id" \
      --conversation "$target_conversation_id")"
    list_status=$?
    set -e
    if (( list_status != 0 )); then
      echo "$runner schedule inspection failed; do not retry cron add." >&2
    elif [[ -z "${list_json//[[:space:]]/}" ]]; then
      echo "$runner schedule inspection returned no JSON; do not retry cron add." >&2
    elif ! jq -cer \
      --arg runner "$runner" '
      if type != "array" then error("invalid schedule list response")
      else map({id, runner: (.runner // $runner), name, conversation_id}) end
    ' <<<"$list_json" >&2; then
      echo "$runner schedule inspection was unparseable; do not retry cron add." >&2
    fi
    unset list_json
  done
  echo "Recovery output can be empty or incomplete and never authorizes retrying cron add; creation may have committed." >&2
}

set +e
created_json="$(letta cron add \
  --name "$schedule_name" \
  --description "$schedule_description" \
  --prompt "$prompt" \
  --at "in 30m" \
  --agent "$agent_id" \
  --conversation "$target_conversation_id")"
create_status=$?
set -e
if (( create_status != 0 )) || [[ -z "${created_json//[[:space:]]/}" ]]; then
  echo "cron add had an ambiguous outcome; inspect projected recovery metadata below." >&2
  inspect_ambiguous_schedules
  exit 1
fi
set +e
created_id="$(jq -er '.id | select(type == "string" and length > 0)' <<<"$created_json")"
created_id_status=$?
set -e
if (( created_id_status != 0 )) || [[ -z "$created_id" ]]; then
  echo "cron add returned an unparseable result; inspect projected recovery metadata below." >&2
  inspect_ambiguous_schedules
  exit 1
fi
printf 'Created schedule %s. If verification fails, inspect or delete this ID; do not rerun cron add.\n' "$created_id" >&2
if ! jq -e \
  --arg id "$created_id" \
  --arg agent_id "$agent_id" \
  --arg conversation_id "$target_conversation_id" '
  type == "object" and
  .id == $id and
  .agent_id == $agent_id and
  .conversation_id == $conversation_id
' <<<"$created_json" >/dev/null; then
  echo "Created schedule $created_id but its create response did not match the requested scope. Inspect or delete that ID; do not rerun cron add." >&2
  exit 1
fi
set +e
verified_json="$(letta cron get "$created_id" --agent "$agent_id")"
get_status=$?
set -e
if (( get_status != 0 )) || [[ -z "${verified_json//[[:space:]]/}" ]]; then
  echo "Created schedule $created_id but could not verify it. Inspect or delete that ID; do not rerun cron add." >&2
  exit 1
fi
if ! jq -e \
  --arg id "$created_id" \
  --arg conversation_id "$target_conversation_id" \
  --arg prompt "$prompt" '
  type == "object" and
  .id == $id and
  .conversation_id == $conversation_id and
  .prompt == $prompt
' <<<"$verified_json" >/dev/null; then
  echo "Created schedule $created_id but its stored scope or prompt did not match. Inspect or delete that ID; do not rerun cron add." >&2
  exit 1
fi
```

Stop instead of guessing when the route is missing or ambiguous. Route state can
change after schedule creation, so the iMessage gateway revalidates account,
organization, agent, conversation, paired/enabled/outbound state, rollout, and
billing when the schedule fires. Treat a `MessageChannel` error as a failed
delivery; schedule execution alone is not proof of delivery. Never put a phone
number in the prompt or command. If the request did not arrive in the target
iMessage conversation, ask the user to schedule from that conversation instead
of weakening the conversation-match check. If post-creation verification fails,
inspect or delete the printed schedule ID before deciding whether to retry.
