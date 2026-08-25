> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Persist sessions to external storage

> Mirror session transcripts to S3, Redis, or your own backend so other hosts can resume your sessions.

By default, the SDK writes session transcripts to JSONL files under `~/.claude/projects/` on the local filesystem. A `SessionStore` adapter lets you mirror those transcripts to your own backend, such as S3, Redis, or a database, so a session created on one host can be resumed on another host running from a matching working directory.

Common reasons to use a session store:

* **Multi-host deployments.** Serverless functions, autoscaled workers, and CI runners don't share a filesystem. A shared store lets replicas resume each other's sessions.
* **Durability.** Local containers are ephemeral. A store backed by S3 or a database survives restarts and redeploys.
* **Compliance and audit.** Keep transcripts in storage you already govern, with your own retention rules, encryption, and access controls.

## The `SessionStore` interface

A `SessionStore` is an object with two required methods, `append` and `load`, and four optional methods. The SDK calls `append` to write transcript entries during a query and `load` to read them back for resume.

<CodeGroup>
  ```typescript TypeScript theme={null}
  // Exported from @anthropic-ai/claude-agent-sdk as
  // SessionStore, SessionKey, SessionStoreEntry, SessionSummaryEntry.

  type SessionKey = {
    projectKey: string;
    sessionId: string;
    subpath?: string;
  };

  type SessionStore = {
    // Required
    append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
    load(key: SessionKey): Promise<SessionStoreEntry[] | null>;

    // Optional
    listSessions?(
      projectKey: string,
    ): Promise<Array<{ sessionId: string; mtime: number }>>;
    listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>;
    delete?(key: SessionKey): Promise<void>;
    listSubkeys?(key: {
      projectKey: string;
      sessionId: string;
    }): Promise<string[]>;
  };

  type SessionSummaryEntry = {
    sessionId: string;
    mtime: number;
    data: Record<string, unknown>;
  };
  ```

  ```python Python theme={null}
  # Exported from claude_agent_sdk as
  # SessionStore, SessionKey, SessionStoreEntry, SessionSummaryEntry.

  class SessionKey(TypedDict):
      project_key: str
      session_id: str
      subpath: NotRequired[str]

  class SessionStore(Protocol):
      # Required
      async def append(
          self, key: SessionKey, entries: list[SessionStoreEntry]
      ) -> None: ...
      async def load(self, key: SessionKey) -> list[SessionStoreEntry] | None: ...

      # Optional — omit or raise NotImplementedError
      async def list_sessions(
          self, project_key: str
      ) -> list[SessionStoreListEntry]: ...
      async def list_session_summaries(
          self, project_key: str
      ) -> list[SessionSummaryEntry]: ...
      async def delete(self, key: SessionKey) -> None: ...
      async def list_subkeys(self, key: SessionListSubkeysKey) -> list[str]: ...

  class SessionSummaryEntry(TypedDict):
      session_id: str
      mtime: int
      data: dict[str, Any]
  ```
</CodeGroup>

`SessionKey` addresses one transcript. `projectKey` is a stable, filesystem-safe encoding of the working directory, `sessionId` is the session UUID, and `subpath` is set when the entry belongs to a subagent transcript or sidecar file rather than the main conversation.

Because `projectKey` encodes the working directory, resume or continue from the store from a working directory matching the original run's. In TypeScript, if you set [`CLAUDE_CODE_PROJECT_DIR_NAME`](/docs/en/sessions#name-the-project-directory-yourself) beside `CLAUDE_CONFIG_DIR` in a query's [`env` option](/docs/en/agent-sdk/typescript#options), the SDK keys that query's entries, and its `resume` and `continue` lookups, by that name instead. Because standalone helpers such as `listSessions` and `deleteSession` take no `env` and read the process environment, set `CLAUDE_CONFIG_DIR` and the same name in the host process environment too. Requires Agent SDK v0.3.234 or later.

Treat `subpath` as an opaque key suffix; it follows the on-disk layout, for example `subagents/agent-<id>`. When `subpath` is undefined the key refers to the main transcript.

| Method                 | Required | Called when                                                                                                                                                                                                                                                                                               |
| :--------------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append`               | Yes      | After each batch of transcript entries is written locally. Entries are JSON-safe objects, one per line in the local JSONL.                                                                                                                                                                                |
| `load`                 | Yes      | Before the subprocess spawns when `resume` is set or `continue: true` resolves the newest store session, and once per session when listing falls back from `listSessionSummaries`. Return `null` if the session is unknown.                                                                               |
| `listSessions`         | No       | By `listSessions({ sessionStore })` and by `query()`/`startup()` with `continue: true`. If undefined, `continue: true` throws, and `listSessions({ sessionStore })` throws unless `listSessionSummaries` is implemented.                                                                                  |
| `listSessionSummaries` | No       | By `listSessions({ sessionStore })` to read metadata for all sessions in one call. Maintain the summaries inside `append`. If undefined, listing falls back to `listSessions` plus a per-session `load`.                                                                                                  |
| `delete`               | No       | By `deleteSession({ sessionStore })`. Deleting the main key (no `subpath`) must cascade to all subkeys for that session and also remove the session's summary entry, so a deleted session stops appearing in `listSessionSummaries`. If undefined, deletion is a no-op, which suits append-only backends. |
| `listSubkeys`          | No       | During resume, to discover subagent transcripts. If undefined, only the main transcript is restored.                                                                                                                                                                                                      |

In a `SessionSummaryEntry`, `mtime` is the sidecar's storage write time and must share a clock source with the `mtime` values `listSessions` returns. `data` is opaque SDK-owned state; persist it verbatim without interpreting it.

Build the entries by calling the exported `foldSessionSummary` helper, `fold_session_summary` in Python, on each batch inside `append`. Skip batches whose key has a `subpath`; subagent transcripts must not contribute to the main session's summary. The fold never sets `mtime`: stamp it at persist time, through the `options.mtime` argument in TypeScript or by overwriting the field on the returned entry in Python. Concurrent `append` calls for the same session can race on the sidecar, so serialize the read-fold-write with a transaction, a compare-and-swap, or a per-session lock; the fold itself is pure.

For what the SDK does with the transcript `load` returns, see [Resume from the store](#resume-from-the-store).

## Quick start

The SDK ships an `InMemorySessionStore` for development and testing. The example below runs a query with the store attached, captures the session ID from the result message, then resumes from the store in a second `query()` call. The second call passes the same store instance plus `resume`, so the SDK loads the transcript from the store instead of the local filesystem:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query, InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk";

  const store = new InMemorySessionStore();

  let sessionId: string | undefined;
  try {
    for await (const message of query({
      prompt: "List the TypeScript files under src/",
      options: { sessionStore: store },
    })) {
      if (message.type === "result") {
        sessionId = message.session_id;
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result. If the
    // failure was an error result, sessionId was already captured by the loop
    // above; connection or process failures yield no result message.
    console.error(`Session ended with an error: ${error}`);
  }

  // Resume from the store. The agent has full context from the first call.
  for await (const message of query({
    prompt: "Summarize what those files do",
    options: { sessionStore: store, resume: sessionId },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import (
      ClaudeAgentOptions,
      InMemorySessionStore,
      ResultMessage,
      query,
  )

  store = InMemorySessionStore()


  async def main():
      session_id = None
      try:
          async for message in query(
              prompt="List the Python files under src/",
              options=ClaudeAgentOptions(session_store=store),
          ):
              if isinstance(message, ResultMessage):
                  session_id = message.session_id
      except Exception as error:
          # A single-shot query() raises after yielding an error result. If the
          # failure was an error result, session_id was already captured by the
          # loop above; connection or process failures yield no result message.
          print(f"Session ended with an error: {error}")

      # Resume from the store. The agent has full context from the first call.
      async for message in query(
          prompt="Summarize what those files do",
          options=ClaudeAgentOptions(session_store=store, resume=session_id),
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

The second query prints a summary of the files from the first query, which shows the agent resumed with full context from the store.

## Write your own adapter

Implement `append` and `load` against your backend. Add `listSessions`, `listSessionSummaries`, `delete`, and `listSubkeys` if you want `listSessions()`, one-call metadata reads, `deleteSession()`, and subagent resume to work against the store.

Entries passed to `append` are typed as `SessionStoreEntry` (a `{ type: string; ... }` object). Treat them as opaque JSON-safe values: persist them in order and return them from `load` in the same order. `load` must return entries that are deep-equal to what was appended; byte-equal serialization is not required, so backends like Postgres `jsonb` that reorder object keys are fine.

## Reference implementations

The TypeScript SDK repository includes runnable reference adapters for S3, Redis, and Postgres under [`examples/session-stores/`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores). They are not published to npm; copy the `src/` file you need into your project and install the corresponding backend client.

| Adapter                                                                                                                        | Backend client       | Storage model                                                                |
| :----------------------------------------------------------------------------------------------------------------------------- | :------------------- | :--------------------------------------------------------------------------- |
| [`S3SessionStore`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/s3)             | `@aws-sdk/client-s3` | One JSONL part file per `append()`; `load()` lists, sorts, and concatenates. |
| [`RedisSessionStore`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/redis)       | `ioredis`            | `RPUSH`/`LRANGE` list per transcript, plus a sorted-set session index.       |
| [`PostgresSessionStore`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/postgres) | `pg`                 | One row per entry in a `jsonb` table, ordered by `BIGSERIAL`.                |

Each adapter takes a pre-configured client instance, so you control credentials, TLS, region, and pooling. For example, with S3:

```typescript TypeScript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";
import { S3Client } from "@aws-sdk/client-s3";
import { S3SessionStore } from "./S3SessionStore"; // copied from examples/session-stores/s3

const store = new S3SessionStore({
  bucket: "my-claude-sessions",
  prefix: "transcripts",
  client: new S3Client({ region: "us-east-1" }),
});

for await (const message of query({
  prompt: "Hello!",
  options: { sessionStore: store },
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}

// Later, possibly on a different host:
for await (const message of query({
  prompt: "Continue where we left off",
  options: { sessionStore: store, resume: "previous-session-id" },
})) {
  // ...
}
```

### Validate your adapter

Both SDKs ship a conformance suite that asserts the behavioral contract `append`, `load`, and the optional methods must satisfy. Tests for optional methods skip automatically when those methods are not implemented.

In TypeScript, copy [`shared/conformance.ts`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/shared/conformance.ts) from the example directory into your test suite. In Python, the suite ships in the package. To run it with pytest, which isn't an SDK dependency, install pytest first:

```bash theme={null}
pip install pytest
```

Then pass your adapter to the suite in a test file as a zero-argument factory, which `run_session_store_conformance` calls once per contract to build a fresh store:

```python Python theme={null}
import pytest
from claude_agent_sdk.testing import run_session_store_conformance


@pytest.mark.anyio
async def test_my_store_conformance():
    await run_session_store_conformance(MyRedisStore)
```

Passing the `MyRedisStore` class itself, as this example does, works when the constructor takes no arguments. For an adapter that takes a pre-configured client, pass a lambda that constructs the store instead. Because the contracts reuse the same session keys, each store the factory returns must start with empty storage, so have the lambda provision isolated backing storage per call, such as a fresh in-memory fake, a unique key prefix, or a new test database.

## Behavior notes

### Dual-write architecture

The Claude Code subprocess always writes each batch of transcript entries to local disk first, and the SDK then forwards the same batch to your store's `append()`, so the store is a mirror of the local transcript rather than a replacement for it. Which copy outlives the run depends on how the run started:

* **Fresh session, or a resume when the store has nothing for the session**: the local transcript under your config directory outlives the run, and the store receives a copy.
* **Run [resumed from the store](#resume-from-the-store)**: the local copy is deleted at run end, so the store holds the only durable copy.

If you don't want a fresh session to leave a transcript on local disk, set `CLAUDE_CONFIG_DIR` to a temp directory in `options.env`. A run resumed from the store already deletes its local copy, so it needs no such setting. In TypeScript, spread `process.env` into `env` as well, since the [`env` option](/docs/en/agent-sdk/typescript#options) replaces the subprocess environment.

If your app signs in through files in the config directory, such as OAuth credentials or an `apiKeyHelper` in your user `settings.json`, copy those files into the temp directory first, or set `ANTHROPIC_API_KEY` in `env` instead. Otherwise the run fails with `Not logged in`.

Two options conflict with the mirror, and the SDK throws at startup if you combine either with a store:

* **`persistSession: false`** in TypeScript: turns off the local writes the mirror is built from. The Python SDK has no equivalent option.
* **File checkpointing**, `enableFileCheckpointing` in TypeScript or `enable_file_checkpointing` in Python: writes its file backups straight to local disk, and the SDK doesn't mirror them to the store.

### Resume from the store

When you pass `resume`, or `continue: true` in TypeScript or `continue_conversation=True` in Python, together with a store, the SDK asks the store for a transcript before it spawns the subprocess:

* **`resume`**: the SDK asks for the session whose ID you passed.
* **`continue: true`** or **`continue_conversation=True`**: the SDK asks for the store's newest session.

When the store returns the transcript, the SDK writes it into a temporary config directory, runs the subprocess with `CLAUDE_CONFIG_DIR` pointing there, and deletes the directory when the run ends. The local transcript that run writes is deleted with it, which is why the store holds the only durable copy on this path.

The SDK also seeds the temporary directory with files from your real config directory. What it copies differs by language:

* **TypeScript**: credentials, `.claude.json`, and your user `settings.json`. From `settings.json` it strips the keys that misbehave under a temporary config directory: `enabledPlugins`, `extraKnownMarketplaces`, its [`additionalMarketplaces`](/docs/en/settings-reference#extraknownmarketplaces) alias, and any `CLAUDE_CONFIG_DIR` in the file's `env` block. Before Agent SDK v0.3.232, the SDK didn't strip the alias. Auth configured in settings, such as [`apiKeyHelper`](/docs/en/settings-reference#apikeyhelper), works when you resume from the store. Before Agent SDK v0.3.222, the TypeScript SDK copied only credentials and `.claude.json`.
* **Python**: credentials and `.claude.json` only, so an app that authenticates through `apiKeyHelper` in your user `settings.json` fails with `Not logged in` when resuming from a store. An `apiKeyHelper` in managed or project settings still works, because Claude Code reads those files from locations that `CLAUDE_CONFIG_DIR` doesn't affect.

When the store has nothing for the session, the SDK runs under your real config directory instead, and the outcome depends on which option you passed:

* **`resume`**: both SDKs pass the ID through to the subprocess, which resumes the local transcript exactly as `resume` does without a store.
* **`continue: true`** in TypeScript: the SDK starts a fresh session.
* **`continue_conversation=True`** in Python: the SDK continues from the newest local session.

### Mirror writes are best-effort

If `append()` rejects, the SDK retries the batch up to two more times with a short backoff, for at most three attempts in total. A call that times out isn't retried, since the original call may still land. If the batch still fails, the SDK logs the error, emits a `{ type: "system", subtype: "mirror_error" }` message into the iterator, drops the batch, and continues the query. Because a retried batch can re-deliver entries that already landed, deduplicate by `entry.uuid` in your `append()` implementation.

A store outage doesn't interrupt the agent, since the subprocess writes locally first. Monitor for `mirror_error` if you need to detect store data loss. On a run [resumed from the store](#resume-from-the-store), a dropped batch has no surviving copy once the run ends.

### `getSessionMessages` returns the post-compaction chain

`getSessionMessages({ sessionStore })` returns the linked message chain the agent would see on resume. After auto-compaction, earlier turns are replaced by a summary, so a session whose store holds 503 raw entries may return 18 messages from `getSessionMessages`. For the full raw history, including pre-compaction turns and metadata entries, call `store.load(key)` directly.

### `forkSession` is not a byte copy

`forkSession({ sessionStore })` reads the source entries, rewrites every `sessionId` field and remaps message UUIDs, then appends the transformed entries under a new key. An adapter-level copy or `CopyObject` shortcut would produce a transcript that still references the old session ID, so the SDK does not use one.

### Subagent transcripts

Subagent transcripts are mirrored under `subpath: "subagents/agent-<id>"`. `listSubagents({ sessionStore })` requires the adapter to implement `listSubkeys`; `getSubagentMessages({ sessionStore })` uses it when available but falls back to the direct subpath when it is undefined. Resume also calls `listSubkeys` to restore subagent files; without it, only the main transcript is materialized.

### Retention

The SDK never deletes from your store on its own. Retention is the adapter's responsibility: implement TTLs, S3 lifecycle policies, or scheduled cleanup according to your compliance requirements.

Local transcripts under `CLAUDE_CONFIG_DIR` are swept independently by the `cleanupPeriodDays` setting, following the [retention sweep rules](/docs/en/claude-directory#cleaned-up-automatically). A run [resumed from the store](#resume-from-the-store) leaves no local transcript, so for those runs your store's retention is the only retention there is.

## Supported on

The following TypeScript SDK functions accept a `sessionStore` option and operate against the store instead of the local filesystem when it is provided:

* [`query()`](/docs/en/agent-sdk/typescript#query)
* [`startup()`](/docs/en/agent-sdk/typescript#startup)
* [`listSessions()`](/docs/en/agent-sdk/typescript#listsessions)
* [`getSessionInfo()`](/docs/en/agent-sdk/typescript#getsessioninfo)
* [`getSessionMessages()`](/docs/en/agent-sdk/typescript#getsessionmessages)
* [`renameSession()`](/docs/en/agent-sdk/typescript#renamesession)
* [`tagSession()`](/docs/en/agent-sdk/typescript#tagsession)
* [`deleteSession()`](/docs/en/agent-sdk/typescript)
* [`forkSession()`](/docs/en/agent-sdk/typescript)
* [`listSubagents()`](/docs/en/agent-sdk/typescript)
* [`getSubagentMessages()`](/docs/en/agent-sdk/typescript)

In the Python SDK, set `session_store` in [`ClaudeAgentOptions`](/docs/en/agent-sdk/python#claudeagentoptions) to run `query()` against a store. The remaining operations each have a store-backed Python function that takes the store as an argument: `list_sessions_from_store()`, `get_session_info_from_store()`, `get_session_messages_from_store()`, `list_subagents_from_store()`, `get_subagent_messages_from_store()`, `rename_session_via_store()`, `tag_session_via_store()`, `delete_session_via_store()`, and `fork_session_via_store()`. `startup()` has no Python equivalent. The standalone functions documented in the [Python SDK reference](/docs/en/agent-sdk/python#functions), such as `list_sessions()`, read local session files.

## Related resources

* [Work with sessions](/docs/en/agent-sdk/sessions): Continue, resume, and fork without a custom store
* [Host the SDK](/docs/en/agent-sdk/hosting): Deployment patterns for multi-host environments
* [TypeScript `Options`](/docs/en/agent-sdk/typescript#options): Full option reference
* [`examples/session-stores/`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores): Runnable S3, Redis, and Postgres reference adapters
