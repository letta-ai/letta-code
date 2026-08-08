# Model Settings Reference

Use these examples when constructing `model_settings`. Send only fields supported by the target provider.

## Reasoning shapes

| Provider/model handle | Reasoning shape |
| --- | --- |
| `openai/...` | `model_settings.reasoning.reasoning_effort` |
| `chatgpt_oauth/...` | `model_settings.reasoning.reasoning_effort` with `provider_type: "chatgpt_oauth"` |
| `anthropic/...` | `model_settings.effort`, optionally `model_settings.thinking` |
| `bedrock/...` Claude models | `provider_type: "bedrock"`; check current API schema before sending reasoning fields |
| `google_ai/...` or `google_vertex/...` | `model_settings.thinking_config.thinking_budget`, optionally `include_thoughts` |

Reasoning/effort values are provider-dependent. Common OpenAI values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Anthropic effort commonly uses `low`, `medium`, `high`, `xhigh`, or `max` on supported models.

## OpenAI

```json
{
  "provider_type": "openai",
  "parallel_tool_calls": true,
  "reasoning": { "reasoning_effort": "medium" },
  "max_output_tokens": 128000
}
```

## Anthropic

```json
{
  "provider_type": "anthropic",
  "parallel_tool_calls": true,
  "effort": "medium",
  "thinking": { "type": "enabled", "budget_tokens": 12000 },
  "max_output_tokens": 128000
}
```

## Google AI

```json
{
  "provider_type": "google_ai",
  "parallel_tool_calls": true,
  "thinking_config": { "thinking_budget": 12000, "include_thoughts": false }
}
```

## Common failure modes

- `model_settings` is usually replacement-style. Fetch the current object first and preserve fields you still need.
- `PATCH` acceptance does not guarantee runtime model availability. A model handle can pass API shape validation but still fail when the next generation resolves providers/routes. Test new handles conversation-scoped before changing agent defaults.
- Do not send OpenAI `reasoning.reasoning_effort` to Anthropic models.
- For agent responses, verify effective context at `llm_config.context_window`; `context_window_limit` may be null or normalized in the response.
