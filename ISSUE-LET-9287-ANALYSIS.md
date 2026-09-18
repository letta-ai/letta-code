# LET-9287: letta/auto max_tokens_exceeded Analysis and Fix

## Issue Summary

Users experiencing `Unexpected stop reason: max_tokens_exceeded` errors when using `letta/auto` for read-only coding tasks, despite a previously announced fix on June 26, 2026.

**Reporter**: nano8a (Discord user `1126888754599166012`)  
**Date**: June 29, 2026 (recurrence after June 26 fix)  
**Linear Issue**: LET-9287

## Root Cause

The `letta/auto` model router is configured with **only 28,000 max_output_tokens**, while all other modern models have **128,000 max_output_tokens** - a **4.5x difference**.

### Configuration Comparison

| Model | max_output_tokens |
|-------|-------------------|
| `letta/auto` | **28,000** ❌ |
| GPT-5.5 | 128,000 ✅ |
| GPT-5.6 Sol/Terra/Luna | 128,000 ✅ |
| Claude Fable 5 | 128,000 ✅ |
| Claude Opus 4.8 | 128,000 ✅ |
| Claude Sonnet 5 | 128,000 ✅ |

### Why This Causes Failures

For verbose agentic tasks involving:
- Multiple file reads
- Code searches
- Bash command outputs
- Planning/catch-up sessions

...28k tokens can be easily exceeded. The user's read-only coding task hit this limit, forcing a manual switch to GPT-5.5 (128k tokens) to continue.

### Why the June 26 Fix Didn't Work

Ari mentioned pushing a fix on June 26, but the issue recurred June 29. Possible explanations:

1. **Backend routing change only**: The fix may have changed which underlying model Auto routes to, but didn't address the `max_output_tokens` configuration issue
2. **Incomplete deployment**: The fix may not have deployed to all Auto routing paths
3. **Client-side limit persists**: Even if the backend model has higher limits, the client applies the catalog's `max_output_tokens` value (28k) to the request

## Architecture Context

### How letta/auto Works

- **Client-side**: `letta/auto` is a **router handle** - the client doesn't select the underlying model
- **Backend-side**: Cloud API performs server-side model selection based on task characteristics
- **Token limits**: Come from `GET /v1/models/catalog` endpoint and are applied by both:
  1. Client: Sets `max_output_tokens` in the LLM request
  2. Backend: Enforces the limit during generation

### How Limits Are Applied

```typescript
// src/agent/remote-model-catalog.ts
if (typeof entry.maxOutputTokens === "number") {
  updateArgs.max_output_tokens = entry.maxOutputTokens;
}

// src/agent/modify.ts
if (
  typeof updateArgs?.max_output_tokens === "number" &&
  updateArgs.max_output_tokens > 0
) {
  (settings as Record<string, unknown>).max_output_tokens =
    updateArgs.max_output_tokens;
}
```

### How max_tokens_exceeded Is Handled

The client treats `max_tokens_exceeded` as a **terminal/non-retriable** stop reason:

- TUI: `src/cli/app/retry.ts`
- Listener: `src/websocket/listener/recovery.ts`
- Headless: `src/headless.ts`

No automatic retry or fallback occurs - the user must manually switch models.

## The Fix

### Client-Side Changes

Update the test fixture to reflect the corrected configuration:

```diff
  "updateArgs": {
    "context_window": 140000,
-   "max_output_tokens": 28000,
+   "max_output_tokens": 128000,
    "parallel_tool_calls": true
  }
```

**File**: `src/test-utils/fixtures/runtime-model-catalog.json`

### Backend-Side Changes Required

The Cloud catalog (`GET /v1/models/catalog`) must be updated to return:

```json
{
  "id": "auto",
  "handle": "letta/auto",
  "maxOutputTokens": 128000
}
```

This is a **backend configuration change** outside this repository.

## Impact

### Before Fix
- Users hit `max_tokens_exceeded` on verbose read-only tasks
- Manual model switching required (disrupts workflow)
- Loss of trust in automode for cost-effective tasks

### After Fix
- Consistent token budget across all models
- No manual intervention needed for typical agentic tasks
- Automode becomes viable for verbose planning/catch-up sessions

## Testing Plan

1. **Verify catalog value**: Query `GET /v1/models/catalog` in production and confirm `maxOutputTokens: 128000` for `letta/auto`
2. **Regression test**: Execute a verbose multi-file read task with automode and verify it completes without hitting limits
3. **Comparison test**: Run the same task with both `letta/auto` and GPT-5.5 and verify similar completion rates

## Related Code References

- Model catalog types: `src/agent/remote-model-catalog.ts` (line 56: `maxOutputTokens`)
- Catalog application: `src/agent/modify.ts` (line 272-281: `max_output_tokens` logic)
- Stop reason handling: `src/backend/dev/provider-turn-executor.ts` (line 483-490: maps `length` → `max_tokens_exceeded`)
- Test fixture: `src/test-utils/fixtures/runtime-model-catalog.json` (line 10-14: Auto updateArgs)

## Additional Notes

- The test fixture update alone doesn't fix the production issue - it only ensures our tests use the correct expected value
- The backend catalog is the source of truth for production deployments
- This issue affects **all users** using automode for verbose tasks, not just the reporter
- Related PR #3810 fixed resume-refresh token override issues, but didn't address the base catalog value

## Recommended Follow-Up

1. **Backend team**: Update Cloud catalog `maxOutputTokens` for `letta/auto` from 28k → 128k
2. **Validation**: Add a catalog value validation test that flags when Auto has significantly lower limits than other featured models
3. **Monitoring**: Track `max_tokens_exceeded` stop reasons by model handle to catch similar issues early
4. **Documentation**: Update any user-facing docs about automode's capabilities and limitations
