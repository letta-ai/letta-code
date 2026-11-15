# External coding-agent traces

Cloud-authenticated Claude Code and Codex workers can send raw model-call traces
through a local logging proxy. This requires a compatible Letta Cloud server.
The proxy forwards credentials upstream but does not include HTTP headers in
trace records. Credential fields and known secret values are redacted from the
captured JSON; forwarded request and response bytes are unchanged.

Set `LETTA_CODE_TELEM=0`, `LETTA_CODE_TELEM=false`, or `DO_NOT_TRACK=1` to disable
capture and upload. Self-hosted and unauthenticated sessions do not upload.

Batches upload to `POST /v1/conversations/:conversationId/llm-trace`.

Each row includes the harness, model, parent agent/conversation, background task,
native worker session, request/response JSON, usage, latency, HTTP status, errors,
and creation time. Unknown usage/cost values are null. For streaming responses,
`response_json` contains the assembled `response`, the original parsed SSE
`events`, and a `complete` flag. This retains provider-specific fields that are
not present in the assembled message.

Capture buffers allow 2 MiB per request/response payload, up to eight concurrent
payload buffers, and a 64 MiB upload queue per session. Oversized payloads retain a row
with `capture_status: "size_limit"` and an explicit omission marker. Uploads are
best effort, batched, and retried up to three times; process termination or queue
exhaustion can lose traces. Incomplete streams are marked `incomplete`.

Claude uses `ANTHROPIC_BASE_URL`. Codex reads its effective provider configuration
and starts app-server with an HTTP Responses provider routed through the proxy;
ChatGPT auth continues to use the ChatGPT backend upstream. Custom HTTP providers
retain their configured authentication. Native session files remain separate
from model API tracing and are not described as exact request captures.
