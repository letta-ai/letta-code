> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent SDK reference - TypeScript

> Complete API reference for the TypeScript Agent SDK, including all functions, types, and interfaces.

<script src="/docs/components/typescript-sdk-type-links.js" defer />

## Installation

```bash theme={null}
npm install @anthropic-ai/claude-agent-sdk
```

<Note>
  The SDK bundles a native Claude Code binary for your platform as an optional dependency such as `@anthropic-ai/claude-agent-sdk-darwin-arm64`. Most installs need no separate Claude Code install. The SDK version tracks the bundled Claude Code version: SDK v0.3.191 bundles Claude Code v2.1.191, so a feature on this page that requires a Claude Code version needs the SDK release with the same patch number or later. If your package manager skips optional dependencies, the SDK throws `Native CLI binary for <platform> not found`; set [`pathToClaudeCodeExecutable`](#options) to a separately installed `claude` binary instead.

  If your package manager doesn't apply npm's `libc` field, as Yarn 1.x doesn't, you get both the glibc and musl platform packages on Linux, roughly doubling the install size. The SDK still launches the correct variant. To reclaim the space in a container image, delete the platform package that doesn't match the libc where your app runs; for a glibc runtime on x64, that's `rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl`. On a development machine the deletion is temporary, since Yarn reinstalls the package on the next dependency change.
</Note>

### Compile to a single executable

When you compile your application into a single-file executable with `bun build --compile`, the SDK cannot resolve the bundled CLI binary at runtime. `require.resolve` does not work inside the compiled executable's `$bunfs` virtual filesystem, so the SDK throws `Native CLI binary for <platform> not found`.

To work around this, embed the platform binary as a file asset, extract it to a real path at startup with `extractFromBunfs()`, and pass that path to [`pathToClaudeCodeExecutable`](#options).

The `extractFromBunfs()` helper requires `@anthropic-ai/claude-agent-sdk` v0.3.144 or later. The example below builds for macOS on Apple Silicon:

```typescript theme={null}
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { query } from "@anthropic-ai/claude-agent-sdk";

const cliPath = extractFromBunfs(binPath);

for await (const message of query({
  prompt: "Hello",
  options: { pathToClaudeCodeExecutable: cliPath },
})) {
  console.log(message);
}
```

`extractFromBunfs()` copies the embedded binary out of the compiled executable's virtual filesystem to a per-user temp directory and returns the real path. Outside a compiled executable it returns the input path unchanged, so the same code runs in development without modification.

Each compiled executable embeds a single platform's binary. Match the platform package in the import to your `--target`:

* To cross-compile, install the non-matching platform package, for example `npm install @anthropic-ai/claude-agent-sdk-linux-x64 --force`.
* On Windows, the binary subpath is `claude.exe`, for example `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`.

## Functions

### `query()`

The primary function for interacting with Claude Code. Creates an async generator that streams messages as they arrive.

```typescript theme={null}
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

#### Parameters

| Parameter | Type                                                             | Description                                                       |
| :-------- | :--------------------------------------------------------------- | :---------------------------------------------------------------- |
| `prompt`  | `string \| AsyncIterable<`[`SDKUserMessage`](#sdkusermessage)`>` | The input prompt as a string or async iterable for streaming mode |
| `options` | [`Options`](#options)                                            | Optional configuration object (see Options type below)            |

#### Returns

Returns a [`Query`](#query-object) object that extends `AsyncGenerator<`[`SDKMessage`](#sdkmessage)`, void>` with additional methods.

### `startup()`

Pre-warms the CLI subprocess by spawning it and completing the initialize handshake before a prompt is available. The returned [`WarmQuery`](#warmquery) handle accepts a prompt later and writes it to an already-ready process, so the first `query()` call resolves without paying subprocess spawn and initialization cost inline.

```typescript theme={null}
function startup(params?: {
  options?: Options;
  initializeTimeoutMs?: number;
}): Promise<WarmQuery>;
```

#### Parameters

| Parameter             | Type                  | Description                                                                                                                                                                    |
| :-------------------- | :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options`             | [`Options`](#options) | Optional configuration object. Same as the `options` parameter to `query()`                                                                                                    |
| `initializeTimeoutMs` | `number`              | Maximum time in milliseconds to wait for subprocess initialization. Defaults to `60000`. If initialization does not complete in time, the promise rejects with a timeout error |

#### Returns

Returns a `Promise<`[`WarmQuery`](#warmquery)`>` that resolves once the subprocess has spawned and completed its initialize handshake.

#### Example

Call `startup()` early, for example on application boot, then call `.query()` on the returned handle once a prompt is ready. This moves subprocess spawn and initialization out of the critical path.

```typescript theme={null}
import { startup } from "@anthropic-ai/claude-agent-sdk";

// Pay startup cost upfront
const warm = await startup({ options: { maxTurns: 3 } });

// Later, when a prompt is ready, this is immediate
for await (const message of warm.query("What files are here?")) {
  console.log(message);
}
```

### `tool()`

Creates a type-safe MCP tool definition for use with SDK MCP servers.

```typescript theme={null}
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }
): SdkMcpToolDefinition<Schema>;
```

#### Parameters

| Parameter     | Type                                                                                                   | Description                                                                                                                                                                                                                                                                                                   |
| :------------ | :----------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | `string`                                                                                               | The name of the tool                                                                                                                                                                                                                                                                                          |
| `description` | `string`                                                                                               | A description of what the tool does                                                                                                                                                                                                                                                                           |
| `inputSchema` | `Schema extends AnyZodRawShape`                                                                        | Zod schema defining the tool's input parameters (supports both Zod 3 and Zod 4)                                                                                                                                                                                                                               |
| `handler`     | `(args, extra) => Promise<`[`CallToolResult`](#calltoolresult)`>`                                      | Async function that executes the tool logic                                                                                                                                                                                                                                                                   |
| `extras`      | `{ annotations?: `[`ToolAnnotations`](#toolannotations)`; searchHint?: string; alwaysLoad?: boolean }` | Optional extras. `annotations` provides MCP behavioral hints to clients. `searchHint` is a one-line capability phrase shown in the deferred-tool list when [tool search](/docs/en/agent-sdk/tool-search) is active. `alwaysLoad: true` keeps this tool's full schema in the initial prompt instead of deferring it |

#### `ToolAnnotations`

Re-exported from `@modelcontextprotocol/sdk/types.js`. All fields are optional hints; clients should not rely on them for security decisions.

| Field             | Type      | Default     | Description                                                                                                                                          |
| :---------------- | :-------- | :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | `string`  | `undefined` | Human-readable title for the tool                                                                                                                    |
| `readOnlyHint`    | `boolean` | `false`     | If `true`, the tool does not modify its environment                                                                                                  |
| `destructiveHint` | `boolean` | `true`      | If `true`, the tool may perform destructive updates (only meaningful when `readOnlyHint` is `false`)                                                 |
| `idempotentHint`  | `boolean` | `false`     | If `true`, repeated calls with the same arguments have no additional effect (only meaningful when `readOnlyHint` is `false`)                         |
| `openWorldHint`   | `boolean` | `true`      | If `true`, the tool interacts with external entities (for example, web search). If `false`, the tool's domain is closed (for example, a memory tool) |

```typescript theme={null}
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const searchTool = tool(
  "search",
  "Search the web",
  { query: z.string() },
  async ({ query }) => {
    return { content: [{ type: "text", text: `Results for: ${query}` }] };
  },
  { annotations: { readOnlyHint: true, openWorldHint: true } }
);
```

### `createSdkMcpServer()`

Creates an MCP server instance that runs in the same process as your application.

```typescript theme={null}
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  instructions?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
  alwaysLoad?: boolean;
}): McpSdkServerConfigWithInstance;
```

#### Parameters

| Parameter              | Type                          | Description                                                                                                                                                                                          |
| :--------------------- | :---------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.name`         | `string`                      | The name of the MCP server                                                                                                                                                                           |
| `options.version`      | `string`                      | Optional version string                                                                                                                                                                              |
| `options.instructions` | `string`                      | Optional server instructions, returned from `initialize` and surfaced to the model as an MCP instructions block                                                                                      |
| `options.tools`        | `Array<SdkMcpToolDefinition>` | Array of tool definitions created with [`tool()`](#tool)                                                                                                                                             |
| `options.alwaysLoad`   | `boolean`                     | When `true`, every tool from this server stays in the initial prompt and is never deferred behind [tool search](/docs/en/agent-sdk/tool-search). Combines with per-tool `alwaysLoad` in [`tool()`](#tool) |

### `listSessions()`

Discovers and lists past sessions with light metadata. Filter by project directory or list sessions across all projects.

```typescript theme={null}
function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
```

#### Parameters

| Parameter                  | Type      | Default     | Description                                                                        |
| :------------------------- | :-------- | :---------- | :--------------------------------------------------------------------------------- |
| `options.dir`              | `string`  | `undefined` | Directory to list sessions for. When omitted, returns sessions across all projects |
| `options.limit`            | `number`  | `undefined` | Maximum number of sessions to return                                               |
| `options.includeWorktrees` | `boolean` | `true`      | When `dir` is inside a git repository, include sessions from all worktree paths    |

#### Return type: `SDKSessionInfo`

| Property       | Type                  | Description                                                                 |
| :------------- | :-------------------- | :-------------------------------------------------------------------------- |
| `sessionId`    | `string`              | Unique session identifier (UUID)                                            |
| `summary`      | `string`              | Display title: custom title, auto-generated summary, or first prompt        |
| `lastModified` | `number`              | Last modified time in milliseconds since epoch                              |
| `fileSize`     | `number \| undefined` | Session file size in bytes. Only populated for local JSONL storage          |
| `customTitle`  | `string \| undefined` | User-set session title (via `/rename`)                                      |
| `firstPrompt`  | `string \| undefined` | First meaningful user prompt in the session                                 |
| `gitBranch`    | `string \| undefined` | Git branch at the end of the session                                        |
| `cwd`          | `string \| undefined` | Working directory for the session                                           |
| `tag`          | `string \| undefined` | User-set session tag (see [`tagSession()`](#tagsession))                    |
| `createdAt`    | `number \| undefined` | Creation time in milliseconds since epoch, from the first entry's timestamp |

#### Example

Print the 10 most recent sessions for a project. Results are sorted by `lastModified` descending, so the first item is the newest. Omit `dir` to search across all projects.

```typescript theme={null}
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });

for (const session of sessions) {
  console.log(`${session.summary} (${session.sessionId})`);
}
```

### `getSessionMessages()`

Reads user and assistant messages from a past session transcript.

```typescript theme={null}
function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>;
```

#### Parameters

| Parameter        | Type     | Default     | Description                                                                   |
| :--------------- | :------- | :---------- | :---------------------------------------------------------------------------- |
| `sessionId`      | `string` | required    | Session UUID to read (see `listSessions()`)                                   |
| `options.dir`    | `string` | `undefined` | Project directory to find the session in. When omitted, searches all projects |
| `options.limit`  | `number` | `undefined` | Maximum number of messages to return                                          |
| `options.offset` | `number` | `undefined` | Number of messages to skip from the start                                     |

#### Return type: `SessionMessage`

| Property             | Type                    | Description                                                                                                                                                                                                                                                                   |
| :------------------- | :---------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `"user" \| "assistant"` | Message role                                                                                                                                                                                                                                                                  |
| `uuid`               | `string`                | Unique message identifier                                                                                                                                                                                                                                                     |
| `session_id`         | `string`                | Session this message belongs to                                                                                                                                                                                                                                               |
| `message`            | `unknown`               | Raw message payload from the transcript                                                                                                                                                                                                                                       |
| `parent_tool_use_id` | `string \| null`        | For subagent messages, the `tool_use_id` of the spawning `Agent` tool call. `null` for main-session messages and older sessions                                                                                                                                               |
| `parent_agent_id`    | `string \| null`        | For messages from a [nested subagent](/docs/en/sub-agents#let-subagents-spawn-their-own-subagents), the `agentId` of the subagent that spawned it. `null` for main-session messages, messages from top-level subagents, and older sessions. Requires Claude Code v2.1.202 or later |

#### Example

```typescript theme={null}
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

const [latest] = await listSessions({ dir: "/path/to/project", limit: 1 });

if (latest) {
  const messages = await getSessionMessages(latest.sessionId, {
    dir: "/path/to/project",
    limit: 20
  });

  for (const msg of messages) {
    console.log(`[${msg.type}] ${msg.uuid}`);
  }
}
```

### `getSessionInfo()`

Reads metadata for a single session by ID without scanning the full project directory.

```typescript theme={null}
function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions
): Promise<SDKSessionInfo | undefined>;
```

#### Parameters

| Parameter     | Type     | Default     | Description                                                            |
| :------------ | :------- | :---------- | :--------------------------------------------------------------------- |
| `sessionId`   | `string` | required    | UUID of the session to look up                                         |
| `options.dir` | `string` | `undefined` | Project directory path. When omitted, searches all project directories |

Returns [`SDKSessionInfo`](#return-type-sdksessioninfo), or `undefined` if the session is not found.

### `renameSession()`

Renames a session by appending a custom-title entry. Repeated calls are safe; the most recent title wins.

```typescript theme={null}
function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions
): Promise<void>;
```

#### Parameters

| Parameter     | Type     | Default     | Description                                                            |
| :------------ | :------- | :---------- | :--------------------------------------------------------------------- |
| `sessionId`   | `string` | required    | UUID of the session to rename                                          |
| `title`       | `string` | required    | New title. Must be non-empty after trimming whitespace                 |
| `options.dir` | `string` | `undefined` | Project directory path. When omitted, searches all project directories |

### `tagSession()`

Tags a session. Pass `null` to clear the tag. Repeated calls are safe; the most recent tag wins.

```typescript theme={null}
function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions
): Promise<void>;
```

#### Parameters

| Parameter     | Type             | Default     | Description                                                            |
| :------------ | :--------------- | :---------- | :--------------------------------------------------------------------- |
| `sessionId`   | `string`         | required    | UUID of the session to tag                                             |
| `tag`         | `string \| null` | required    | Tag string, or `null` to clear                                         |
| `options.dir` | `string`         | `undefined` | Project directory path. When omitted, searches all project directories |

### `resolveSettings()`

Resolves the effective Claude Code settings for a given directory using the same merge engine as the CLI, without spawning the Claude CLI. Use it to inspect what configuration a `query()` call would see before invoking one.

<Note>
  This function is alpha and its API may change before stabilization. It reads MDM sources, including macOS plist and Windows HKLM/HKCU, for parity with CLI startup, but does not execute the admin-configured `policyHelper` subprocess. The `permissions.defaultMode` field is returned as-is from all tiers including project settings. In a live session, the CLI [ignores `defaultMode: 'auto'` from project and local settings](/docs/en/permission-modes#eliminate-prompts-with-auto-mode); `resolveSettings()` skips that check, so an `auto` from those tiers appears here even though a session would ignore it.
</Note>

```typescript theme={null}
function resolveSettings(
  options?: ResolveSettingsOptions
): Promise<ResolvedSettings>;
```

#### Parameters

`resolveSettings()` accepts a single options object. All fields are optional.

| Parameter                       | Type                                  | Default         | Description                                                                                                                                                                                                                                                                                                                                                              |
| :------------------------------ | :------------------------------------ | :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.cwd`                   | `string`                              | `process.cwd()` | Directory to resolve project and local settings relative to                                                                                                                                                                                                                                                                                                              |
| `options.settingSources`        | [`SettingSource`](#settingsource)`[]` | All sources     | Which filesystem sources to load. Pass `[]` to skip user, project, and local settings. [Endpoint-managed policy](/docs/en/managed-settings#delivery-mechanisms) loads in all cases. Server-managed settings are taken from `serverManagedSettings` when the host passes it, or read from the CLI's on-disk cache otherwise; the snapshot does not fetch them from the network |
| `options.managedSettings`       | `Settings`                            | `undefined`     | Policy-tier settings supplied by the embedding host. Follows the same rules as [`managedSettings` in `Options`](#options), except that `resolveSettings()` doesn't execute a configured [`policyHelper`](/docs/en/settings-reference#policyhelper), so the snapshot can include settings that a live session drops                                                            |
| `options.serverManagedSettings` | `Settings`                            | `undefined`     | Server-managed settings payload from `/api/claude_code/settings`. Non-restrictive keys pass through unfiltered                                                                                                                                                                                                                                                           |

#### Return type: `ResolvedSettings`

`resolveSettings()` returns an object describing the merged settings and the source that contributed each key.

| Property     | Type                                                | Description                                                            |
| :----------- | :-------------------------------------------------- | :--------------------------------------------------------------------- |
| `effective`  | `Settings`                                          | Merged settings after applying all enabled sources in precedence order |
| `provenance` | `Partial<Record<keyof Settings, ProvenanceEntry>>`  | For each top-level key in `effective`, which source supplied the value |
| `sources`    | `Array<{ source, settings, path?, policyOrigin? }>` | Per-source raw settings, ordered from lowest to highest precedence     |

#### Example

The example below resolves settings for a project directory and prints the source that controls the cleanup period. On a machine where no settings file sets `cleanupPeriodDays`, both printed lines show `undefined` for the value, which is the expected output rather than an error.

```typescript theme={null}
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

const { effective, provenance } = await resolveSettings({
  cwd: "/path/to/project",
  settingSources: ["user", "project", "local"],
});

console.log(`Cleanup period: ${effective.cleanupPeriodDays} days`);
console.log(`Set by: ${provenance.cleanupPeriodDays?.source}`);
```

## Types

### `Options`

Configuration object for the `query()` function.

| Property                          | Type                                                                                                     | Default                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `abortController`                 | `AbortController`                                                                                        | `new AbortController()`                     | Controller for cancelling operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `additionalDirectories`           | `string[]`                                                                                               | `[]`                                        | Additional directories Claude can access. The SDK passes each entry to Claude Code as `--add-dir`, so with the `project` setting source Claude Code also [loads the directory's skills, commands, and subagents](/docs/en/permissions#additional-directories-grant-file-access-not-configuration)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agent`                           | `string`                                                                                                 | `undefined`                                 | Agent name for the main thread. The agent must be defined in the `agents` option or in settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `agents`                          | `Record<string, [`AgentDefinition`](#agentdefinition)>`                                                  | `undefined`                                 | Programmatically define subagents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `agentProgressSummaries`          | `boolean`                                                                                                | `false`                                     | When `true`, generate one-line progress summaries for subagents and forward them on [`task_progress`](#sdktaskprogressmessage) events via the `summary` field. Applies to foreground and background subagents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `allowDangerouslySkipPermissions` | `boolean`                                                                                                | `false`                                     | Enable bypassing permissions. Required when using `permissionMode: 'bypassPermissions'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `allowedTools`                    | `string[]`                                                                                               | `[]`                                        | Tools to auto-approve without prompting. This does not restrict Claude to only these tools. If you name one of the [task-tracking tools](/docs/en/agent-sdk/todo-tracking#model-availability) here, Claude Code also opts the session in. Other unlisted tools fall through to `permissionMode` and `canUseTool`. Use `disallowedTools` to block tools. See [Permissions](/docs/en/agent-sdk/permissions#allow-and-deny-rules)                                                                                                                                                                                                                                                                                                                                                      |
| `betas`                           | [`SdkBeta`](#sdkbeta)`[]`                                                                                | `[]`                                        | Enable beta features                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `canUseTool`                      | [`CanUseTool`](#canusetool)                                                                              | `undefined`                                 | Custom permission function, invoked only when the [permission flow](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) falls through to a prompt. Not invoked for calls auto-approved by `allowedTools`, allow rules, or `permissionMode`. An allow rule doesn't pre-approve the [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves). See [`CanUseTool`](#canusetool) for details                                                                                                                                                                                                                                                                                                                                                   |
| `continue`                        | `boolean`                                                                                                | `false`                                     | Continue the most recent conversation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cwd`                             | `string`                                                                                                 | `process.cwd()`                             | Current working directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `debug`                           | `boolean`                                                                                                | `false`                                     | Enable debug mode for the Claude Code process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `debugFile`                       | `string`                                                                                                 | `undefined`                                 | Write debug logs to a specific file path. Implicitly enables debug mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `disallowedTools`                 | `string[]`                                                                                               | `[]`                                        | Tools to deny. A bare name such as `"Bash"` removes the tool from Claude's context. A scoped rule such as `"Bash(rm *)"` leaves the tool available and denies matching calls in every permission mode, including `bypassPermissions`. See [Permissions](/docs/en/agent-sdk/permissions#allow-and-deny-rules)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `effort`                          | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`                                                        | Model default                               | Controls how much effort Claude puts into its response. Works with adaptive thinking to guide thinking depth. See [adjust the effort level](/docs/en/model-config#adjust-effort-level)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `enableFileCheckpointing`         | `boolean`                                                                                                | `false`                                     | Enable file change tracking for rewinding. See [File checkpointing](/docs/en/agent-sdk/file-checkpointing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `env`                             | `Record<string, string \| undefined>`                                                                    | `process.env`                               | Environment variables. When set, this replaces the subprocess environment instead of merging with `process.env`, so pass `{ ...process.env, YOUR_VAR: 'value' }` to keep inherited variables like `PATH`. See [Handle slow or stalled API responses](#handle-slow-or-stalled-api-responses) for an example of this pattern, and [Environment variables](/docs/en/env-vars) for variables the underlying CLI reads. Set `CLAUDE_AGENT_SDK_CLIENT_APP` to identify your app in the User-Agent header                                                                                                                                                                                                                                                                             |
| `executable`                      | `'bun' \| 'deno' \| 'node'`                                                                              | Auto-detected                               | JavaScript runtime to use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `executableArgs`                  | `string[]`                                                                                               | `[]`                                        | Arguments to pass to the executable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `extraArgs`                       | `Record<string, string \| null>`                                                                         | `{}`                                        | Additional arguments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fallbackModel`                   | `string`                                                                                                 | `undefined`                                 | Model to use if primary fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `forkSession`                     | `boolean`                                                                                                | `false`                                     | When resuming with `resume`, fork to a new session ID instead of continuing the original session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `forwardSubagentText`             | `boolean`                                                                                                | `false`                                     | Forward subagent text and thinking blocks as assistant and user messages with `parent_tool_use_id` set, so consumers can render a nested transcript. By default only `tool_use` and `tool_result` blocks from subagents are emitted. Messages from subagents at every nesting depth are forwarded on Claude Code v2.1.219 and later; before v2.1.219, only messages from depth-1 subagents appeared                                                                                                                                                                                                                                                                                                                                                                       |
| `hooks`                           | `Partial<Record<`[`HookEvent`](#hookevent)`, `[`HookCallbackMatcher`](#hookcallbackmatcher)`[]>>`        | `{}`                                        | Hook callbacks for events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `includeHookEvents`               | `boolean`                                                                                                | `false`                                     | Include hook lifecycle events in the message stream as [`SDKHookStartedMessage`](#sdkhookstartedmessage), [`SDKHookProgressMessage`](#sdkhookprogressmessage), and [`SDKHookResponseMessage`](#sdkhookresponsemessage). Lifecycle events for `SessionStart` and `Setup` hooks are always included and don't need this option. Some hook events, such as `Notification`, `SessionEnd`, `PreCompact`, and `PostCompact`, never produce an `SDKHookStartedMessage`, even with this option. For those events, Claude Code still emits an `SDKHookProgressMessage` while a command hook that runs for more than a second produces output, and emits an `SDKHookResponseMessage` only when a hook [that runs in the background](/docs/en/hooks#run-hooks-in-the-background) finishes |
| `includePartialMessages`          | `boolean`                                                                                                | `false`                                     | Include partial message events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `loadTimeoutMs`                   | `number`                                                                                                 | `60000`                                     | *Alpha.* Timeout in milliseconds for each `sessionStore.load()` and `sessionStore.listSubkeys()` call during resume materialization. If the adapter doesn't settle within this window, the query fails instead of hanging. Ignored when `sessionStore` is not set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `managedSettings`                 | `Settings`                                                                                               | `undefined`                                 | Policy-tier settings your host process supplies to the spawned session. On machines with admin-deployed managed settings, Claude Code ignores these unless the admin's highest-priority managed source sets `parentSettingsBehavior: 'merge'`, and never merges them while a [`policyHelper`](/docs/en/settings-reference#policyhelper) supplies managed settings. Merged values pass through a restrictive-only filter; [Restrict parent settings](/docs/en/claude-apps-gateway#restrict-parent-settings) covers what the filter admits and the `allowManaged*Only` locks                                                                                                                                                                                                          |
| `maxBudgetUsd`                    | `number`                                                                                                 | `undefined`                                 | Stop the query when the client-side cost estimate reaches this USD value. Compared against the same estimate as `total_cost_usd`; see [Track cost and usage](/docs/en/agent-sdk/cost-tracking) for accuracy caveats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxThinkingTokens`               | `number`                                                                                                 | `undefined`                                 | *Deprecated:* Use `thinking` instead. Maximum tokens for thinking process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `maxTurns`                        | `number`                                                                                                 | `undefined`                                 | Maximum agentic turns (tool-use round trips)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mcpServers`                      | `Record<string, [`McpServerConfig`](#mcpserverconfig)>`                                                  | `{}`                                        | MCP server configurations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `model`                           | `string`                                                                                                 | Default from CLI                            | Claude model alias or full model name. See [accepted values and provider-specific IDs](/docs/en/model-config#available-models)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `onElicitation`                   | `(request: ElicitationRequest, options: { signal: AbortSignal }) => Promise<ElicitationResult>`          | `undefined`                                 | Callback for handling MCP elicitation requests. Called when an MCP server requests user input and no hook handles it first. When not provided, unhandled elicitation requests are declined automatically                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `outputFormat`                    | `{ type: 'json_schema', schema: JSONSchema }`                                                            | `undefined`                                 | Define output format for agent results. See [Structured outputs](/docs/en/agent-sdk/structured-outputs) for details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `outputStyle`                     | `string`                                                                                                 | `undefined`                                 | Not an `Options` field. Set `outputStyle` in the inline [`settings`](/docs/en/settings) object or a settings file instead. See [Activate an output style](/docs/en/agent-sdk/modifying-system-prompts#activate-an-output-style)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pathToClaudeCodeExecutable`      | `string`                                                                                                 | Auto-resolved from bundled native binary    | Path to Claude Code executable. Only needed if optional dependencies were skipped during install or your platform isn't in the supported set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `permissionMode`                  | [`PermissionMode`](#permissionmode)                                                                      | `'default'`                                 | Permission mode for the session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `permissionPromptToolName`        | `string`                                                                                                 | `undefined`                                 | MCP tool name for permission prompts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `persistSession`                  | `boolean`                                                                                                | `true`                                      | When `false`, disables session persistence to disk. Sessions cannot be resumed later                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `planModeInstructions`            | `string`                                                                                                 | `undefined`                                 | Custom workflow instructions for plan mode. When `permissionMode` is `'plan'`, this string replaces the default plan-mode workflow body. The CLI still wraps it with the read-only enforcement preamble and the ExitPlanMode protocol footer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plugins`                         | [`SdkPluginConfig`](#sdkpluginconfig)`[]`                                                                | `[]`                                        | Load custom plugins from local paths. See [Plugins](/docs/en/agent-sdk/plugins) for details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `promptSuggestions`               | `boolean`                                                                                                | `false`                                     | Enable prompt suggestions. After a turn, Claude Code emits a `prompt_suggestion` message carrying a predicted next user prompt. Claude Code generates no suggestion for some turns, such as while your account is close to or at its usage limit. See [When Claude Code skips suggestions](/docs/en/interactive-mode#when-claude-code-skips-suggestions)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `resume`                          | `string`                                                                                                 | `undefined`                                 | Session ID to resume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `resumeDropsTurn`                 | `string`                                                                                                 | `undefined`                                 | With `resumeSessionAt`: the prompt UUID of the turn the truncating resume intends to discard. Claude Code refuses the resume when the discarded range contains anything not attributable to that turn, such as absorbed queued messages or task notifications, and names the `--resume-drops-turn` flag in the rejection message. Only the Agent SDK and print-mode resumes read the pair. Requires Claude Code v2.1.223 or later                                                                                                                                                                                                                                                                                                                                         |
| `resumeSessionAt`                 | `string`                                                                                                 | `undefined`                                 | Resume session at a specific message UUID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox`                         | [`SandboxSettings`](#sandboxsettings)                                                                    | `undefined`                                 | Configure sandbox behavior programmatically. See [Sandbox settings](#sandboxsettings) for details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sessionId`                       | `string`                                                                                                 | Auto-generated                              | Use a specific UUID for the session instead of auto-generating one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sessionStore`                    | [`SessionStore`](/docs/en/agent-sdk/session-storage#the-sessionstore-interface)                               | `undefined`                                 | Mirror session transcripts to an external backend so another host can resume them. See [Persist sessions to external storage](/docs/en/agent-sdk/session-storage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sessionStoreFlush`               | `'batched' \| 'eager'`                                                                                   | `'batched'`                                 | *Alpha.* Flush mode for `sessionStore`. Ignored when `sessionStore` is not set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `settings`                        | `string \| Settings`                                                                                     | `undefined`                                 | Inline [settings](/docs/en/settings) object or path to a settings file. Populates the flag-settings layer in the [precedence order](/docs/en/settings#settings-precedence). Change at runtime with [`applyFlagSettings()`](#applyflagsettings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `settingSources`                  | [`SettingSource`](#settingsource)`[]`                                                                    | CLI defaults (all sources)                  | Control which filesystem settings to load. Pass `[]` to disable user, project, and local settings. [Endpoint-managed policy](/docs/en/managed-settings#delivery-mechanisms) loads regardless; server-managed settings are fetched when the session authenticates with an organization credential on an [eligible configuration](/docs/en/server-managed-settings#platform-availability). See [Use Claude Code features](/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control)                                                                                                                                                                                                                                                                                    |
| `skills`                          | `string[] \| 'all'`                                                                                      | `undefined`                                 | Skills available to the session. Pass `'all'` to enable every discovered skill, or a list of skill names. Pass exact names only. The SDK rejects malformed and wildcard-form names with an error before starting the Claude Code process. When set, the SDK adds the Skill tool to `allowedTools` automatically. If you also pass `tools`, include `'Skill'` in that list. See [Skills](/docs/en/agent-sdk/skills)                                                                                                                                                                                                                                                                                                                                                             |
| `spawnClaudeCodeProcess`          | `(options: SpawnOptions) => SpawnedProcess`                                                              | `undefined`                                 | Custom function to spawn the Claude Code process. Use to run Claude Code in VMs, containers, or remote environments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stderr`                          | `(data: string) => void`                                                                                 | `undefined`                                 | Callback for stderr output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `strictMcpConfig`                 | `boolean`                                                                                                | `false`                                     | Use only the servers passed in `mcpServers` and ignore project `.mcp.json`, user settings, plugin-provided MCP servers, and [claude.ai connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `systemPrompt`                    | `string \| { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }` | `undefined` (minimal prompt)                | System prompt configuration. Pass a string for custom prompt, or `{ type: 'preset', preset: 'claude_code' }` to use Claude Code's system prompt. When using the preset object form, add `append` to extend it with additional instructions, and set `excludeDynamicSections: true` to move per-session context into the first user message for [better prompt-cache reuse across machines](/docs/en/agent-sdk/modifying-system-prompts#improve-prompt-caching-across-users-and-machines)                                                                                                                                                                                                                                                                                       |
| `taskBudget`                      | `{ total: number }`                                                                                      | `undefined`                                 | *Alpha.* API-side task budget in tokens. When set, the model is told its remaining token budget so it can pace tool use and wrap up before the limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `thinking`                        | [`ThinkingConfig`](#thinkingconfig)                                                                      | `{ type: 'adaptive' }` for supported models | Controls Claude's thinking/reasoning behavior. See [`ThinkingConfig`](#thinkingconfig) for options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `title`                           | `string`                                                                                                 | `undefined`                                 | Display title for the session. When resuming via `resume` or `continue`, the resumed session's persisted title takes precedence; use [`renameSession()`](#renamesession) to retitle an existing session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `toolAliases`                     | `Record<string, string>`                                                                                 | `undefined`                                 | Map built-in tool names to MCP tool names so Claude calls your MCP implementation in place of the built-in. For example, `{ Bash: 'mcp__workspace__bash' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `toolConfig`                      | [`ToolConfig`](#toolconfig)                                                                              | `undefined`                                 | Configuration for built-in tool behavior. See [`ToolConfig`](#toolconfig) for details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tools`                           | `string[] \| { type: 'preset'; preset: 'claude_code' }`                                                  | `undefined`                                 | Tool configuration. Pass an array of tool names or use the preset to get Claude Code's default tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

#### Handle slow or stalled API responses

The CLI subprocess reads several environment variables that control API timeouts and stall detection. Pass them through the `env` option:

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: "Analyze this code",
  options: {
    env: {
      ...process.env,
      API_TIMEOUT_MS: "120000",
      CLAUDE_CODE_MAX_RETRIES: "2",
      CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "120000",
    },
  },
});
```

* `API_TIMEOUT_MS`: per-request timeout on the Anthropic client, in milliseconds. Default `600000`. Applies to the main loop and all subagents.
* `CLAUDE_CODE_MAX_RETRIES`: maximum API retries. Default `10`, capped at `15`. Each retry gets its own `API_TIMEOUT_MS` window, so worst-case wall time is roughly `API_TIMEOUT_MS × (CLAUDE_CODE_MAX_RETRIES + 1)` plus backoff. For unattended runs that need to wait through longer outages, set [`CLAUDE_CODE_RETRY_WATCHDOG=1`](/docs/en/errors#tune-retry-behavior): it retries transient capacity errors indefinitely and, on Claude Code v2.1.199 or later, raises the default for other transient errors to `300` and removes the cap on this variable.
* `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`: stall watchdog for subagents launched with `run_in_background`. Default `600000`. Resets on each stream event; on stall it aborts the subagent, marks the task failed, and surfaces the error to the parent with any partial result. Does not apply to synchronous subagents.
* `CLAUDE_ENABLE_STREAM_WATCHDOG` with `CLAUDE_STREAM_IDLE_TIMEOUT_MS`: aborts the request when headers have arrived but the response body stops streaming. The watchdog is on by default for all providers; set `CLAUDE_ENABLE_STREAM_WATCHDOG=0` to disable it. `CLAUDE_STREAM_IDLE_TIMEOUT_MS` defaults to `300000` and is clamped to that minimum. After the abort, [Automatic retries](/docs/en/errors#automatic-retries) covers what Claude Code does, based on how far the response had progressed.

### `Query` object

Interface returned by the `query()` function.

```typescript theme={null}
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean }
  ): Promise<RewindFilesResult>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  applyFlagSettings(settings: { [K in keyof Settings]?: Settings[K] | null }): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  reinitialize(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  readFile(
    path: string,
    options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }
  ): Promise<SDKControlReadFileResponse | null>;
  accountInfo(): Promise<AccountInfo>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
```

#### Methods

| Method                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interrupt()`                          | Interrupts the query. Only available in streaming input mode. When the CLI advertises the `interrupt_receipt_v1` capability in [`SDKSystemMessage.capabilities`](#sdksystemmessage), resolves with an [`SDKControlInterruptResponse`](#sdkcontrolinterruptresponse) listing the queued messages that survive the interrupt. Resolves `undefined` on CLIs before v2.1.205                                                                                                                  |
| `rewindFiles(userMessageId, options?)` | Restores files to their state at the specified user message. Pass `{ dryRun: true }` to preview changes. Requires `enableFileCheckpointing: true`. See [File checkpointing](/docs/en/agent-sdk/file-checkpointing)                                                                                                                                                                                                                                                                             |
| `setPermissionMode()`                  | Changes the permission mode (only available in streaming input mode)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `setModel()`                           | Changes the model (only available in streaming input mode). Passing `undefined` or the string `"default"` resets to the session default model                                                                                                                                                                                                                                                                                                                                             |
| `setMaxThinkingTokens()`               | *Deprecated:* Use the `thinking` option instead. Changes the maximum thinking tokens. Passing `null` resets thinking to the session default: a mid-session override is cleared, and thinking stays off for sessions that have it disabled                                                                                                                                                                                                                                                 |
| `applyFlagSettings(settings)`          | Merges settings into the session's flag settings layer at runtime (only available in streaming input mode). See [`applyFlagSettings()`](#applyflagsettings)                                                                                                                                                                                                                                                                                                                               |
| `initializationResult()`               | Returns the full initialization result including supported commands, models, account info, and output style configuration                                                                                                                                                                                                                                                                                                                                                                 |
| `reinitialize()`                       | Re-sends the `initialize` control request to the running CLI and returns a fresh result instead of the cached first-connect result. Use it after a transport gap, such as reattaching to a session after a disconnect, so pending permission requests reach your `canUseTool` callback again. Make the callback idempotent per request ID, because a request whose response was lost is dispatched again. Requires Claude Code v2.1.195 or later                                          |
| `supportedCommands()`                  | Returns available slash commands. From Agent SDK v0.3.216 the list reflects mid-session command changes; see [`SDKCommandsChangedMessage`](#sdkcommandschangedmessage)                                                                                                                                                                                                                                                                                                                    |
| `supportedModels()`                    | Returns available models with display info                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `supportedAgents()`                    | Returns available subagents as [`AgentInfo`](#agentinfo)`[]`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mcpServerStatus()`                    | Returns status of connected MCP servers                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `getContextUsage()`                    | Returns an [`SDKControlGetContextUsageResponse`](#sdkcontrolgetcontextusageresponse) breaking down the session's context window usage by category, skill, and tool. The same data `/context` shows in an interactive session                                                                                                                                                                                                                                                              |
| `readFile(path, options?)`             | Reads a file from the session's filesystem. Claude Code resolves the path against `cwd` and applies the same read-permission rules as the Read tool. Pass `{ maxBytes }` to change the read cap (default 1 MB, ceiling 10 MB) and `{ encoding: 'base64' }` for binary files such as images. Resolves with an [`SDKControlReadFileResponse`](#sdkcontrolreadfileresponse), or `null` on permission denial, a missing file, or a transport error. Requires TypeScript SDK v0.2.121 or later |
| `accountInfo()`                        | Returns account information                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `reconnectMcpServer(serverName)`       | Reconnect an MCP server by name                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `toggleMcpServer(serverName, enabled)` | Enable or disable an MCP server by name                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `setMcpServers(servers)`               | Dynamically replace the set of MCP servers for this session. Returns which servers were added and removed, and any errors. The call keeps plugin-provided servers it doesn't name; naming one replaces it. The promise resolves after newly added stdio, HTTP, and SSE servers connect or fail, so tools from servers that connected are available on the next turn.                                                                                                                      |
| `streamInput(stream)`                  | Stream input messages to the query for multi-turn conversations                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stopTask(taskId)`                     | Stop a running background task by ID                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `close()`                              | Close the query and terminate the underlying process. Forcefully ends the query and cleans up all resources                                                                                                                                                                                                                                                                                                                                                                               |

#### `applyFlagSettings()`

Changes [settings](/docs/en/settings) on a running session without restarting the query. Use it when a setting that has no dedicated setter needs to change mid-session, such as tightening `permissions` after the agent reads untrusted input. `setModel()` and `setPermissionMode()` are dedicated setters for those two keys; `applyFlagSettings()` is the general form that accepts any subset of the settings keys, and passing `model` here behaves the same as `setModel()`.

Only some keys take effect mid-session:

* **Applied on the next turn**: `effortLevel`, `ultracode`, `permissions`, `hooks`, `skillOverrides`, `fastMode`, `agent`. Switching `agent` also applies that agent's model override, hooks, and system prompt on the next turn.
* **Applied during the current turn**: `model`. If you switch `model` while Claude is working on a turn, the response Claude is already generating finishes on the old model, and the rest of the turn, starting with the next call Claude Code makes to the model, uses the new one. Subagents keep their own model. Before v2.1.212, a mid-turn switch waited for the next turn.
* **No effect mid-session**: the system prompt options. These are resolved once at startup, so the running session keeps the original value even though the call succeeds. To change them, start a new session.

`effortLevel` accepts an [effort level](/docs/en/model-config#adjust-effort-level) name. It also accepts `"ultracode"`, which runs the session at `xhigh` effort and turns on [ultracode](/docs/en/workflows#let-claude-decide-with-ultracode). The `Settings` type declares `effortLevel` without that value, so pass the equivalent `{ ultracode: true }` in TypeScript. The `ultracode` value requires Claude Code v2.1.203 or later and is accepted only by `applyFlagSettings()`, not by the `effortLevel` key in a settings file.

The values are written to the flag-settings layer, the same layer the inline `settings` option of `query()` populates at startup. This is the same tier the [on-page precedence section](#settings-precedence) calls programmatic options.

Successive calls shallow-merge top-level keys. A second call with `{ permissions: {...} }` replaces the entire `permissions` object from the prior call rather than deep-merging into it. To clear a key from the flag layer and fall back to lower-precedence sources, pass `null` for that key. Passing `undefined` has no effect because JSON serialization drops it.

Only available in streaming input mode, the same constraint as `setModel()` and `setPermissionMode()`.

The example below switches the active model mid-session, then clears the override so the model falls back to whatever the user or project settings specify.

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({ prompt: messageStream });

// Override the model for the rest of the session
await q.applyFlagSettings({ model: "claude-opus-4-6" });

// Later: clear the override and fall back to lower-precedence settings
await q.applyFlagSettings({ model: null });
```

<Note>
  `applyFlagSettings()` is TypeScript-only. The Python SDK does not expose an equivalent method.
</Note>

### `WarmQuery`

Handle returned by [`startup()`](#startup). The subprocess is already spawned and initialized, so calling `query()` on this handle writes the prompt directly to a ready process with no startup latency.

```typescript theme={null}
interface WarmQuery extends AsyncDisposable {
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
  close(): void;
}
```

#### Methods

| Method          | Description                                                                                                               |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `query(prompt)` | Send a prompt to the pre-warmed subprocess and return a [`Query`](#query-object). Can only be called once per `WarmQuery` |
| `close()`       | Close the subprocess without sending a prompt. Use this to discard a warm query that is no longer needed                  |

`WarmQuery` implements `AsyncDisposable`, so it can be used with `await using` for automatic cleanup.

### `SDKControlInitializeResponse`

Return type of `initializationResult()`. Contains session initialization data.

```typescript theme={null}
type SDKControlInitializeResponse = {
  commands: SlashCommand[];
  agents: AgentInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
  fast_mode_state?: "off" | "cooldown" | "on";
  fast_mode_disabled_reason?: FastModeDisabledReason;
  hooks_applied?: boolean;
};
```

`hooks_applied` reports whether Claude Code registered the `hooks` that the `initialize` request carried. The SDK sends that request once when the session starts and again on each [`reinitialize()`](#query-object) call. The field requires Agent SDK v0.3.238 or later.

Claude Code omits the field when the request carried no hooks. When the request carried hooks, the value depends on whether the request is the session's first initialize and, for a repeated one, on how it reached the session:

* `true`: Claude Code registered the hooks. A session's first initialize returns this value. So does a repeated initialize sent over the CLI's stdin. In that case the hooks in the new request replace the hooks registered earlier.
* `false`: Claude Code ignored the hooks. A repeated initialize sent to a remote session returns this value, so a second client that joins a session can't replace the hooks the first client registered.

Before Agent SDK v0.3.238, the response never carried the field, and Claude Code ignored `hooks` on every repeated initialize.

The response always reports `fast_mode_state`, and when something blocks [fast mode](/docs/en/fast-mode), `fast_mode_disabled_reason` carries the reason code alongside it, so you can explain the blocked state instead of re-deriving availability. Both behaviors require Claude Code v2.1.219 or later. Before v2.1.219, the response omitted `fast_mode_state` when fast mode wasn't available and never carried a reason. For the reason codes and their meanings, see [`fast_mode_disabled_reason`](#sdkresultmessage) on the result message.

When a client sends `initialize` to a session that is already running, the control-response wrapper also carries an optional `pending_permission_requests` array. The field is on the response wrapper itself, not in the `SDKControlInitializeResponse` payload above. Each entry is a complete `control_request` message with the same `{ type: "control_request", request_id, request }` shape the session streams for permission requests while running.

These are requests that were issued before the client connected and are still awaiting a reply. The SDK reads the array for you and dispatches each entry to your [`canUseTool`](#canusetool) callback, the same redelivery that [`reinitialize()`](#query-object) triggers after a transport gap. Handle repeated request IDs idempotently, because an entry can repeat a request the callback already received before the connection dropped.

### `SDKControlInterruptResponse`

The interrupt receipt: the value [`interrupt()`](#query-object) resolves with on a CLI that advertises the `interrupt_receipt_v1` capability in [`SDKSystemMessage.capabilities`](#sdksystemmessage). Requires Claude Code v2.1.205 or later. Earlier CLIs answer the interrupt with an empty success payload, so `interrupt()` resolves to `undefined`.

```typescript theme={null}
type SDKControlInterruptResponse = {
  still_queued: string[];
  cancelled?: string[];
};
```

`still_queued` lists the UUIDs of user messages that survive the interrupt: messages still in the queue, plus any batch already dequeued for the next turn but not yet reachable by the abort. Each one runs as its own turn after the interrupt unless you cancel it first. Use the receipt to decide whether to resend anything; resending a message that is already listed produces a duplicate turn.

Interpret the list with these caveats:

* Only messages that were enqueued with a UUID appear. An empty array doesn't mean nothing else will run.
* Only main-thread messages are listed. Messages addressed to a subagent are out of scope.
* The list can include UUIDs your client never sent, such as [scheduled task](/docs/en/scheduled-tasks) triggers. Ignore UUIDs you don't recognize instead of treating them as an error.

A client that drives the CLI's control protocol directly, rather than through `interrupt()`, can set `cancel_queued: true` on the `interrupt` control request. Claude Code v2.1.219 and later advertises support with the `interrupt_cancel_queued_v1` capability in [`SDKSystemMessage.capabilities`](#sdksystemmessage); older CLIs ignore the field and leave queued messages to run as usual. Such an interrupt also cancels every message that would otherwise be listed under `still_queued`: the receipt lists them under `cancelled` instead, `still_queued` is empty, and none of them run.

The `cancelled` list carries the same caveats as `still_queued`. The `interrupt()` method never sends `cancel_queued`, so receipts it resolves with don't carry `cancelled`.

The receipt is a snapshot taken at the moment the interrupt is processed, and on a clean interrupt it arrives before the interrupted turn's [`SDKResultMessage`](#sdkresultmessage). Read the receipt rather than inspecting the queue after that result: the loop starts the next queued turn immediately, so the queue you inspect after the result has already changed.

### `SDKControlGetContextUsageResponse`

Return type of [`getContextUsage()`](#query-object). This is the same payload Claude Code renders for the `/context` command in an interactive session, so alongside the token counts it carries display fields such as `color` and `gridRows` that Claude Code uses to draw the `/context` usage grid.

When you send `/context` as a prompt instead of calling the method, Claude Code attaches an [`SDKContextUsage`](#sdkcontextusage) payload to the `context_usage` field of the assistant message that delivers the result. That field requires Agent SDK v0.3.232 or later.

```typescript theme={null}
type SDKControlGetContextUsageResponse = {
  categories: {
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: {
    color: string;
    isFilled: boolean;
    categoryName: string;
    tokens: number;
    percentage: number;
    squareFullness: number;
  }[][];
  model: string;
  memoryFiles: {
    path: string;
    type: string;
    tokens: number;
  }[];
  mcpTools: {
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }[];
  deferredBuiltinTools?: {
    name: string;
    tokens: number;
    isLoaded: boolean;
  }[];
  systemTools?: {
    name: string;
    tokens: number;
  }[];
  systemPromptSections?: {
    name: string;
    tokens: number;
  }[];
  agents: {
    agentType: string;
    source: string;
    tokens: number;
  }[];
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: {
      name: string;
      source: string;
      tokens: number;
    }[];
  };
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: {
      name: string;
      callTokens: number;
      resultTokens: number;
    }[];
    attachmentsByType: {
      name: string;
      tokens: number;
    }[];
  };
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
};
```

Read token attribution from the collection fields:

* `categories` holds the per-category totals.
* `mcpTools` and `agents` attribute tokens to individual MCP tools and subagents.
* `memoryFiles` lists each loaded memory file with its cost.
* `skills.skillFrontmatter` attributes the skill listing's tokens to each included skill. The per-skill counts measure each skill's listing entry as Claude Code actually sends it, which can be shorter than the skill's full frontmatter. Compare `skills.totalSkills` with `skills.includedSkills` to see whether every discovered skill made it into the listing.

`totalTokens` is the session's current context usage, and `maxTokens` is the window that usage is measured against. That window is the model's context window, or the lower auto-compaction window when one applies. `rawMaxTokens` carries the same value as `maxTokens`, and `percentage` is `totalTokens` as a rounded percentage of that window.

Claude Code leaves the optional `deferredBuiltinTools`, `systemTools`, and `systemPromptSections` diagnostics unset, so expect them to be absent even though the type declares them.

### `SDKControlReadFileResponse`

Return type of [`readFile()`](#query-object).

```typescript theme={null}
type SDKControlReadFileResponse = {
  contents: string;
  absPath: string;
  truncated?: boolean;
  encoding?: 'base64';
};
```

`contents` holds the file text, or base64 data when you requested `encoding: 'base64'`; the response's `encoding` field is set to `'base64'` in that case. `absPath` is the resolved absolute path. `truncated` is set when the file was longer than the `maxBytes` cap and the contents were cut at that limit.

### `AgentDefinition`

Configuration for a subagent defined programmatically.

```typescript theme={null}
type AgentDefinition = {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: string;
  mcpServers?: AgentMcpServerSpec[];
  skills?: string[];
  initialPrompt?: string;
  maxTurns?: number;
  background?: boolean;
  memory?: "user" | "project" | "local";
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  permissionMode?: PermissionMode;
  criticalSystemReminder_EXPERIMENTAL?: string;
};
```

| Field                                 | Required | Description                                                                                                                                                                                                                        |
| :------------------------------------ | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`                         | Yes      | Natural language description of when to use this agent                                                                                                                                                                             |
| `tools`                               | No       | Array of allowed tool names. If omitted, inherits every [tool available to subagents](/docs/en/sub-agents#available-tools). To preload Skills into the agent's context, use the `skills` field rather than listing `'Skill'` here       |
| `disallowedTools`                     | No       | Array of tool names to explicitly disallow for this agent. MCP server-level patterns are also accepted: `mcp__server` or `mcp__server__*` removes every tool from that server, and `mcp__*` removes every MCP tool from any server |
| `prompt`                              | Yes      | The agent's system prompt                                                                                                                                                                                                          |
| `model`                               | No       | Model override for this agent. Accepts an alias such as `'fable'`, `'opus'`, `'sonnet'`, `'haiku'`, `'inherit'`, or a full model ID. If omitted or `'inherit'`, uses the main model                                                |
| `mcpServers`                          | No       | MCP server specifications for this agent                                                                                                                                                                                           |
| `skills`                              | No       | Array of skill names to preload into the agent context                                                                                                                                                                             |
| `initialPrompt`                       | No       | Auto-submitted as the first user turn when this agent runs as the main thread agent                                                                                                                                                |
| `maxTurns`                            | No       | Maximum number of agentic turns (API round-trips) before stopping                                                                                                                                                                  |
| `background`                          | No       | Run this agent as a non-blocking background task when invoked                                                                                                                                                                      |
| `memory`                              | No       | Memory source for this agent: `'user'`, `'project'`, or `'local'`                                                                                                                                                                  |
| `effort`                              | No       | Reasoning effort level for this agent. Accepts a named level or an integer                                                                                                                                                         |
| `permissionMode`                      | No       | Permission mode for tool execution within this agent. See [`PermissionMode`](#permissionmode)                                                                                                                                      |
| `criticalSystemReminder_EXPERIMENTAL` | No       | Experimental: Critical reminder added to the system prompt                                                                                                                                                                         |

### `AgentMcpServerSpec`

Specifies MCP servers available to a subagent. Can be a server name (string referencing a server from the parent's `mcpServers` config) or an inline server configuration record mapping server names to configs.

```typescript theme={null}
type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;
```

Where `McpServerConfigForProcessTransport` is `McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfig`.

### `SettingSource`

Controls which filesystem-based configuration sources the SDK loads settings from.

```typescript theme={null}
type SettingSource = "user" | "project" | "local";
```

| Value       | Description                                                               | Location                      |
| :---------- | :------------------------------------------------------------------------ | :---------------------------- |
| `'user'`    | Global user settings                                                      | `~/.claude/settings.json`     |
| `'project'` | Shared project settings (version controlled)                              | `.claude/settings.json`       |
| `'local'`   | Local project settings, gitignored when Claude Code saves a setting to it | `.claude/settings.local.json` |

#### Default behavior

When `settingSources` is omitted or `undefined`, `query()` loads the same filesystem settings as the Claude Code CLI: user, project, and local. See [What settingSources does not control](/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control) for inputs that are read regardless of this option, and how to disable them.

#### Why use settingSources

**Disable filesystem settings:**

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

// Do not load user, project, or local settings from disk
const result = query({
  prompt: "Analyze this code",
  options: { settingSources: [] }
});
```

**Load only specific setting sources:**

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

// Load only project settings, ignore user and local
const result = query({
  prompt: "Run CI checks",
  options: {
    settingSources: ["project"] // Only .claude/settings.json
  }
});
```

**Loading CLAUDE.md project instructions:**

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

// Load project settings to include CLAUDE.md files
const result = query({
  prompt: "Add a new feature following project conventions",
  options: {
    systemPrompt: {
      type: "preset",
      preset: "claude_code" // Use Claude Code's system prompt
    },
    settingSources: ["project"], // Loads CLAUDE.md from project directory
    allowedTools: ["Read", "Write", "Edit"]
  }
});
```

#### Settings precedence

When multiple sources are loaded, settings are merged with this precedence (highest to lowest):

1. Local settings (`.claude/settings.local.json`)
2. Project settings (`.claude/settings.json`)
3. User settings (`~/.claude/settings.json`)

Programmatic options such as `agents`, `allowedTools`, and `settings` override user, project, and local filesystem settings. Managed policy settings take precedence over programmatic options.

### `PermissionMode`

```typescript theme={null}
type PermissionMode =
  | "default" // Standard permission behavior
  | "acceptEdits" // Auto-accept file edits
  | "bypassPermissions" // Bypass permission checks; explicit ask rules still prompt
  | "plan" // Planning mode - explore without editing
  | "dontAsk" // Don't prompt for permissions, deny if not pre-approved
  | "auto"; // Model classifier approves or denies permission prompts
```

### `CanUseTool`

Custom permission function type for controlling tool usage.

The function is the SDK replacement for the interactive permission prompt: it's invoked only when the [permission evaluation flow](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) resolves to a prompt. Tool calls already approved by an `allowedTools` entry, a settings allow rule, or the permission mode, such as `acceptEdits` or `bypassPermissions`, never invoke it. To gate every tool call, use a [`PreToolUse` hook](/docs/en/agent-sdk/hooks) instead.

An allow rule doesn't pre-approve the [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves); see [How permissions are evaluated](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) for which of them reach the callback and what happens in `dontAsk` and `auto` mode.

```typescript theme={null}
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
  }
) => Promise<PermissionResult | null>;
```

| Option           | Type                                        | Description                                                                                                                                                                                                                                                                                                  |
| :--------------- | :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | `AbortSignal`                               | Signaled if the operation should be aborted                                                                                                                                                                                                                                                                  |
| `suggestions`    | [`PermissionUpdate`](#permissionupdate)`[]` | Suggested permission updates so the user is not prompted again for this tool. Bash prompts include a suggestion with the `localSettings` [destination](#permissionupdatedestination), so returning it in `updatedPermissions` writes the rule to `.claude/settings.local.json` and persists across sessions. |
| `blockedPath`    | `string`                                    | The file path that triggered the permission request, if applicable                                                                                                                                                                                                                                           |
| `decisionReason` | `string`                                    | Explains why this permission request was triggered                                                                                                                                                                                                                                                           |
| `toolUseID`      | `string`                                    | Unique identifier for this specific tool call within the assistant message                                                                                                                                                                                                                                   |
| `agentID`        | `string`                                    | If running within a sub-agent, the sub-agent's ID                                                                                                                                                                                                                                                            |
| `requestId`      | `string`                                    | The `control_request` envelope's `request_id`. A `control_response` your application sends outside the SDK, such as a signed HTTP POST, must echo this value so the Claude Code process can match the reply to the request                                                                                   |

The callback normally resolves the request by returning a [`PermissionResult`](#permissionresult), which the SDK writes back over its transport as the `control_response`. Return `null` only when your application has already sent the `control_response` for this request over its own channel, echoing `requestId`; the SDK then skips writing the response to its transport. Returning `null` in any other case leaves the tool call blocked indefinitely, because no `control_response` is ever sent and permission prompts don't time out.

The `requestId` option and the `null` return value require Claude Code v2.1.199 or later.

### `PermissionResult`

Result of a permission check.

```typescript theme={null}
type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };
```

### `ToolConfig`

Configuration for built-in tool behavior.

```typescript theme={null}
type ToolConfig = {
  askUserQuestion?: {
    previewFormat?: "markdown" | "html";
  };
};
```

| Field                           | Type                   | Description                                                                                                                                                                   |
| :------------------------------ | :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `askUserQuestion.previewFormat` | `'markdown' \| 'html'` | Opts into the `preview` field on [`AskUserQuestion`](/docs/en/agent-sdk/user-input#question-format) options and sets its content format. When unset, Claude does not emit previews |

### `McpServerConfig`

Configuration for MCP servers.

```typescript theme={null}
type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;
```

#### `McpStdioServerConfig`

```typescript theme={null}
type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
```

#### `McpSSEServerConfig`

```typescript theme={null}
type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};
```

#### `McpHttpServerConfig`

```typescript theme={null}
type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};
```

#### `McpSdkServerConfigWithInstance`

```typescript theme={null}
type McpSdkServerConfigWithInstance = {
  type: "sdk";
  name: string;
  instance: McpServer;
};
```

#### `McpClaudeAIProxyServerConfig`

```typescript theme={null}
type McpClaudeAIProxyServerConfig = {
  type: "claudeai-proxy";
  url: string;
  id: string;
};
```

### `SdkPluginConfig`

Configuration for loading plugins in the SDK.

```typescript theme={null}
type SdkPluginConfig = {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
};
```

| Field              | Type      | Description                                                                                                                                                                                                   |
| :----------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`             | `'local'` | Must be `'local'` (only local plugins currently supported)                                                                                                                                                    |
| `path`             | `string`  | Absolute or relative path to the plugin directory                                                                                                                                                             |
| `skipMcpDiscovery` | `boolean` | When `true`, the SDK loads skills, hooks, agents, and commands from this plugin but does not read its `.mcp.json` or manifest `mcpServers`. Set this when your application owns the plugin's MCP connections. |

**Example:**

```typescript theme={null}
plugins: [
  { type: "local", path: "./my-plugin" },
  { type: "local", path: "/absolute/path/to/plugin" }
];
```

For complete information on creating and using plugins, see [Plugins](/docs/en/agent-sdk/plugins).

## Message Types

### `SDKMessage`

Union type of all possible messages returned by the query.

```typescript theme={null}
type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKPluginInstallMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKBackgroundTasksChangedMessage
  | SDKThinkingTokensMessage
  | SDKSessionStateChangedMessage
  | SDKWorkerShuttingDownMessage
  | SDKCommandsChangedMessage
  | SDKNotificationMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKMemoryRecallMessage
  | SDKRateLimitEvent
  | SDKElicitationCompleteMessage
  | SDKPermissionDeniedMessage
  | SDKPromptSuggestionMessage
  | SDKAPIRetryMessage
  | SDKMirrorErrorMessage
  | SDKInformationalMessage
  | SDKConversationResetMessage;
```

### `SDKAssistantMessage`

Assistant response message.

```typescript theme={null}
type SDKAssistantMessage = {
  type: "assistant";
  uuid: UUID;
  session_id: string;
  message: BetaMessage; // From Anthropic SDK
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
  aborted?: true;
  timestamp?: string;
  context_usage?: SDKContextUsage;
};
```

The `message` field is a [`BetaMessage`](https://platform.claude.com/docs/en/api/messages/create) from the Anthropic SDK. It includes fields like `id`, `content`, `model`, `stop_reason`, and `usage`.

`SDKAssistantMessageError` is one of: `'authentication_failed'`, `'oauth_org_not_allowed'`, `'billing_error'`, `'rate_limit'`, `'overloaded'`, `'invalid_request'`, `'model_not_found'`, `'server_error'`, `'max_output_tokens'`, or `'unknown'`. `'model_not_found'` means the selected model doesn't exist or isn't available to your account or deployment. `'overloaded'` means the API returned a 529 because the server is at capacity, as opposed to `'rate_limit'`, which is a 429 against your quota.

`aborted` is `true` when an interrupt or abort truncated the assistant message before the stream completed: the message has no `stop_reason` and the content may end mid-word. The field is absent on normally completed messages. It requires Agent SDK v0.3.214 or later.

`timestamp` is the ISO 8601 time when the message's content finished generating on the process that produced it. The value comes from that machine's clock, so use it for display only and don't order messages by it. One API turn can produce several assistant messages that share a `message.id`, each with its own `timestamp`. When the field is absent, fall back to the time you received the message.

`context_usage` is a structured copy of the `/context` report, typed as [`SDKContextUsage`](#sdkcontextusage), and requires Agent SDK v0.3.232 or later. When you send `/context` as a prompt, Claude Code delivers the report as an assistant message whose `message.content` holds the markdown table, and attaches `context_usage` to that same message. Claude Code doesn't set the field on any other assistant message, and earlier versions deliver the `/context` table without it, so read the breakdown from the field when it's present and fall back to the markdown text when it isn't.

### `SDKUserMessage`

User input message.

```typescript theme={null}
type SDKUserMessage = {
  type: "user";
  uuid?: UUID;
  session_id?: string;
  message: MessageParam; // From Anthropic SDK
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  shouldQuery?: boolean;
  tool_use_result?: unknown;
  origin?: SDKMessageOrigin;
};
```

Set `shouldQuery` to `false` to append the message to the transcript without triggering an assistant turn. The message is held and merged into the next user message that does trigger a turn. Use this to inject context, such as the output of a command you ran out of band, without spending a model call on it.

On a message that carries a `tool_result` block, `tool_use_result` is the tool's structured output object rather than the text sent to the model. Its shape depends on the tool named by the matching `tool_use` block, so the field is typed `unknown`; the built-in shapes are listed under [Tool Output Types](#tool-output-types).

For the `Agent` tool, `tool_use_result` is [`AgentOutput`](#agent-2). On a `completed` result, `content` holds the subagent's report without the agent ID and usage trailer that Claude Code appends to the `tool_result` text, so render from `tool_use_result` instead of parsing that text.

### `SDKUserMessageReplay`

Replayed user message with required UUID.

```typescript theme={null}
type SDKUserMessageReplay = {
  type: "user";
  uuid: UUID;
  session_id: string;
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  origin?: SDKMessageOrigin;
  isReplay: true;
};
```

A user turn injected from outside the session, one whose [`origin`](#sdkmessageorigin) kind is `peer` or `channel`, reaches the stream as a replay whether it was delivered during an active turn or started a new turn while the session was idle. Before v2.1.207, an injected turn delivered while the session was idle produced no message on the stream and only appeared when you re-read the transcript.

### `SDKResultMessage`

Final result message.

```typescript theme={null}
type SDKResultMessage =
  | {
      type: "result";
      subtype: "success";
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      api_error_status?: number | null;
      num_turns: number;
      result: string;
      stop_reason: string | null;
      ttft_ms?: number;
      ttft_stream_ms?: number;
      user_message_uuid?: string;
      request_sent_wall_ms?: number;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      structured_output?: unknown;
      deferred_tool_use?: { id: string; name: string; input: Record<string, unknown> };
      terminal_reason?: TerminalReason;
      fast_mode_state?: FastModeState;
      fast_mode_disabled_reason?: FastModeDisabledReason;
      origin?: SDKMessageOrigin;
    }
  | {
      type: "result";
      subtype:
        | "error_max_turns"
        | "error_during_execution"
        | "error_max_budget_usd"
        | "error_max_structured_output_retries";
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      stop_reason: string | null;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      errors: string[];
      terminal_reason?: TerminalReason;
      fast_mode_state?: FastModeState;
      fast_mode_disabled_reason?: FastModeDisabledReason;
      origin?: SDKMessageOrigin;
    };
```

Several fields on the result carry diagnostic detail beyond `subtype`:

* `api_error_status`: the HTTP status code of the API error that terminated the conversation. Absent or `null` when the turn ended without an API error.
* `ttft_ms`: time to first token in milliseconds, measured when the first complete assistant message arrives. Present on the success arm only.
* `ttft_stream_ms`: time in milliseconds until the first `message_start` stream event, when the response stream opens. Lower than `ttft_ms`; the gap between the two is time spent streaming the first message. Present on the success arm only.
* `user_message_uuid`: the `uuid` of the [`SDKUserMessage`](#sdkusermessage) that started this turn, echoed back so you can match the result to the message you sent. Requires Claude Code v2.1.216 or later. Present on the success arm only, together with `request_sent_wall_ms`; absent on API-error results, subagent calls, and synthetic turns such as scheduled ones.
* `request_sent_wall_ms`: epoch milliseconds at which Claude Code dispatched the API request, for joins against server-side timestamps. Present only together with `user_message_uuid`.
* `usage`: main agent loop only. Excludes subagent and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer `modelUsage` for token/cost accounting.
* `modelUsage`: per-model totals for every model call made through the query pipeline during this `query()` call, including the main loop, subagents, and internal calls such as compaction and Workflow agents. Helper calls outside that pipeline, such as the permission classifier and token-counting requests, are excluded. In streaming-input sessions the totals are cumulative across turns, so read the latest result rather than summing across results. See [Track costs in streaming input mode](/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode) for resets and [Recover totals after a session crash](/docs/en/agent-sdk/cost-tracking#recover-totals-after-a-session-crash) for zeroed results.
* `total_cost_usd`: cumulative estimated cost in USD for this `query()` call, covering the same calls as `modelUsage` and reset at the same points. It is an estimate, not a billing statement. See [Track cost and usage](/docs/en/agent-sdk/cost-tracking) for accuracy caveats.
* `terminal_reason`: why the loop ended. One of `"completed"`, `"max_turns"`, `"tool_deferred"`, `"aborted_streaming"`, `"aborted_tools"`, `"hook_stopped"`, `"stop_hook_prevented"`, `"background_requested"`, `"blocking_limit"`, `"rapid_refill_breaker"`, `"prompt_too_long"`, `"image_error"`, `"model_error"`, `"api_error"`, `"malformed_tool_use_exhausted"`, `"budget_exhausted"`, `"structured_output_retry_exhausted"`, `"tool_deferred_unavailable"`, or `"turn_setup_failed"`.
* `fast_mode_state`: one of `"on"`, `"off"`, or `"cooldown"`.
* `fast_mode_disabled_reason`: why [fast mode](/docs/en/fast-mode) isn't available right now. Absent when nothing blocks fast mode, though a request may still run at standard speed. During the cooldown after a fast mode rate limit, Claude Code reports `fast_mode_state: "cooldown"` with no reason code and re-enables fast mode when the cooldown expires. Requires Claude Code v2.1.219 or later.

Use the reason code to explain why fast mode is off in your own UI instead of re-deriving availability. Each code names the check that blocked fast mode:

| Reason code            | Meaning                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `free`                 | The account doesn't have the paid subscription or usage credits fast mode requires                                                                          |
| `preference`           | The organization has disabled fast mode                                                                                                                     |
| `extra_usage_disabled` | Usage credits are turned off for the account                                                                                                                |
| `network_error`        | The [availability check](/docs/en/fast-mode#use-fast-mode-behind-proxies-and-llm-gateways) couldn't reach `api.anthropic.com`                                    |
| `unknown`              | Claude Code couldn't determine availability                                                                                                                 |
| `not_first_party`      | The session uses a provider other than the Anthropic API                                                                                                    |
| `disabled_by_env`      | [`CLAUDE_CODE_DISABLE_FAST_MODE`](/docs/en/env-vars) is set                                                                                                      |
| `model_not_allowed`    | The fast mode Opus model isn't in the organization's [`availableModels`](/docs/en/model-config#restrict-model-selection) allowlist                               |
| `sdk_opt_in_required`  | The session hasn't opted in to fast mode: pass `fastMode: true` in the [`settings`](#options) option or through [`applyFlagSettings()`](#applyflagsettings) |
| `pending`              | The availability check hasn't completed yet                                                                                                                 |

The same pair of fields appears on [`SDKSystemMessage`](#sdksystemmessage) and on the [`SDKControlInitializeResponse`](#sdkcontrolinitializeresponse), so you can read the fast mode state before the first turn.

The `origin` field forwards the [`SDKMessageOrigin`](#sdkmessageorigin) of the user message that triggered this result. When the SDK injects a synthetic follow-up turn, such as for a finished background task, the resulting `SDKResultMessage` carries `origin: { kind: "task-notification" }`. Routines whose trigger fired and server-verified messages from your other sessions arrive with this kind too, each with the `subkind` described in [Task-notification subkinds](#task-notification-subkinds). Check `kind` to distinguish results that answer your prompt from injected follow-ups before routing or suppressing them.

The field is absent for results emitted before any user turn, such as startup errors.

When a `PreToolUse` hook returns `permissionDecision: "defer"`, the result has `stop_reason: "tool_deferred"` and `deferred_tool_use` carries the pending tool's `id`, `name`, and `input`. Read this field to surface the request in your own UI, then resume with the same `session_id` to continue. See [Defer a tool call for later](/docs/en/hooks#defer-a-tool-call-for-later) for the full round trip.

### `SDKSystemMessage`

System initialization message.

```typescript theme={null}
type SDKSystemMessage = {
  type: "system";
  subtype: "init";
  uuid: UUID;
  session_id: string;
  agents?: string[];
  apiKeySource: ApiKeySource;
  betas?: string[];
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: {
    name: string;
    status: string;
  }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  terminal_slash_commands?: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
  fast_mode_state?: FastModeState;
  fast_mode_disabled_reason?: FastModeDisabledReason;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  capabilities?: string[];
};
```

`fast_mode_state` reports the session's [fast mode](/docs/en/fast-mode) state. When something blocks fast mode, `fast_mode_disabled_reason` names the check that blocked it; the field requires Claude Code v2.1.219 or later. For the reason codes and their meanings, see [`fast_mode_disabled_reason`](#sdkresultmessage) on the result message.

`terminal_slash_commands` names the entries in `slash_commands` whose interface is bound to the local terminal, such as `exit`. You can send them like any other entry in `slash_commands`; the field exists so a remote or mobile client can hide them from its command menus. The field is present only when non-empty, and requires Agent SDK v0.3.229 or later.

* `effort`: the [effort level](/docs/en/model-config#adjust-effort-level) Claude Code sends on the session's next request, or `null` when it sends none. Claude Code sets the field only on the init message it sends to [Remote Control](/docs/en/remote-control) clients, and omits it from the init message your application reads. Requires Agent SDK v0.3.234 or later.

The `capabilities` array names the protocol behaviors this CLI implements, so you can feature-detect instead of comparing `claude_code_version` strings. It is an open set: ignore values you don't recognize, and check for the specific capability whose behavior you rely on. The field requires Claude Code v2.1.205 or later and is absent on earlier CLIs.

| Capability                   | Meaning                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interrupt_receipt_v1`       | [`interrupt()`](#query-object) resolves with an [`SDKControlInterruptResponse`](#sdkcontrolinterruptresponse) receipt naming the queued messages that survive the interrupt                                                                                                                            |
| `interrupt_cancel_queued_v1` | The `interrupt` control request honors `cancel_queued: true`, cancelling the queued messages that would otherwise survive the interrupt and listing them on the receipt's `cancelled` field. See [`SDKControlInterruptResponse`](#sdkcontrolinterruptresponse). Requires Claude Code v2.1.219 or later |

### `SDKPartialAssistantMessage`

Streaming partial message (only when `includePartialMessages` is true). The `parent_tool_use_id` field is always `null`: stream events are emitted for the main session only. For subagent attribution, use complete messages, which carry `parent_tool_use_id`, or enable [`forwardSubagentText`](#options) to receive subagent text and thinking as complete messages.

```typescript theme={null}
type SDKPartialAssistantMessage = {
  type: "stream_event";
  event: BetaRawMessageStreamEvent; // From Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
  ttft_ms?: number; // Time to first token in ms, present only on message_start events
};
```

### `SDKCompactBoundaryMessage`

Message indicating a conversation compaction boundary.

```typescript theme={null}
type SDKCompactBoundaryMessage = {
  type: "system";
  subtype: "compact_boundary";
  uuid: UUID;
  session_id: string;
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
  };
};
```

### `SDKInformationalMessage`

Generic text banner emitted by the loop. Carries non-error status lines, hook feedback such as a `UserPromptSubmit` hook's block reason, and command output. On Claude Code v2.1.227 or later, a hook's [`systemMessage`](/docs/en/hooks#json-output) can arrive as this message, with each line prefixed by the hook's name, such as `PostToolUse:Bash says:`. Whether a hook's `systemMessage` arrives as this message depends on the event. Each [event's section](/docs/en/hooks#hook-events) on the hooks page says how output surfaces. Render `content` as plaintext at the given `level`.

```typescript theme={null}
type SDKInformationalMessage = {
  type: "system";
  subtype: "informational";
  content: string;
  level: "info" | "notice" | "suggestion" | "warning";
  tool_use_id?: string;
  prevent_continuation?: boolean;
  uuid: UUID;
  session_id: string;
};
```

### `SDKWorkerShuttingDownMessage`

Emitted on graceful worker teardown so remote clients can show why the worker exited instead of waiting for heartbeat timeout. The `reason` is a short snake\_case string set by the host CLI, such as `"host_exit"` or `"remote_control_disabled"`. Act on this only when streaming live. A resumed session replays past instances of this message, so ignore them in that case.

```typescript theme={null}
type SDKWorkerShuttingDownMessage = {
  type: "system";
  subtype: "worker_shutting_down";
  reason: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKPluginInstallMessage`

Plugin installation progress event. Emitted when [`CLAUDE_CODE_SYNC_PLUGIN_INSTALL`](/docs/en/env-vars) is set, so your Agent SDK application can track marketplace plugin installation before the first turn. The `started` and `completed` statuses bracket the overall install. The `installed` and `failed` statuses report individual marketplaces and include `name`.

```typescript theme={null}
type SDKPluginInstallMessage = {
  type: "system";
  subtype: "plugin_install";
  status: "started" | "installed" | "failed" | "completed";
  name?: string;
  error?: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKPermissionDeniedMessage`

Stream event emitted when the permission system denies a tool call without an interactive prompt. Use it to render the denial in your UI as it happens, rather than only observing the `is_error` tool result that follows. Which denials it reports depends on how the run handles permission prompts:

* **With a [`canUseTool`](#canusetool) callback**: permission prompts go to your callback, and this event reports the denials Claude Code decides on its own without calling it.
* **With neither**: a bare `-p` run, or `query()` that sets neither `canUseTool` nor `permissionPromptToolName`, denies any tool call that would have prompted, and this event reports those denials as well as the ones Claude Code decides on its own. Before v2.1.223, Claude Code didn't emit this event in runs without a callback.
* **With an MCP prompt tool**, set with `permissionPromptToolName` or the [`--permission-prompt-tool`](/docs/en/cli-reference#cli-flags) flag: Claude Code doesn't emit this event at all, not even for the rule denials it decides on its own.

In every configuration, this event skips any denial decided on the `PreToolUse` hook path, whether the hook denied the call itself or a deny rule overrode the hook's allow or ask decision. The event is also best-effort: occasionally Claude Code records a denial without emitting this event, so `permission_denials` on the [result message](#sdkresultmessage) is the authoritative record.

```typescript theme={null}
type SDKPermissionDeniedMessage = {
  type: "system";
  subtype: "permission_denied";
  tool_name: string;
  tool_use_id: string;
  agent_id?: string;
  decision_reason_type?: string;
  decision_reason?: string;
  message: string;
  uuid: UUID;
  session_id: string;
};
```

| Field                  | Type     | Description                                                                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tool_name`            | `string` | Name of the tool that was denied                                                                                         |
| `tool_use_id`          | `string` | ID of the `tool_use` block this denial answers                                                                           |
| `agent_id`             | `string` | Subagent ID when the denied call originated inside a subagent. Mirrors the field on `can_use_tool` for host-side routing |
| `decision_reason_type` | `string` | Discriminator for the component that decided, such as `"rule"`, `"mode"`, `"classifier"`, or `"asyncAgent"`              |
| `decision_reason`      | `string` | Human-readable reason from the deciding component, when available                                                        |
| `message`              | `string` | Rejection message returned to the model in the `tool_result`                                                             |

### `SDKPermissionDenial`

Information about a denied tool use.

```typescript theme={null}
type SDKPermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
};
```

### `SDKContextUsage`

Structured form of the `/context` report, carried as `context_usage` on the [`SDKAssistantMessage`](#sdkassistantmessage) that delivers a `/context` result. Agent SDK v0.3.232 and later export the type. Unlike [`SDKControlGetContextUsageResponse`](#sdkcontrolgetcontextusageresponse), it carries only the data needed to render the usage breakdown, without display fields such as `color` and `gridRows`.

```typescript theme={null}
type SDKContextUsage = {
  model: string;
  total_tokens: number;
  raw_max_tokens: number;
  percentage: number;
  over_limit?: {
    tokens_over: number;
    kind: "hard_limit" | "compaction_window";
  };
  categories: SDKContextUsageCategory[];
  mcp_tools: {
    name: string;
    server_name: string;
    tokens: number;
  }[];
  memory_files: {
    path: string;
    type: string;
    tokens: number;
  }[];
  agents: {
    agent_type: string;
    source: string;
    tokens: number;
  }[];
  skills?: {
    name: string;
    source: string;
    plugin_name?: string;
    tokens: number;
  }[];
};
```

The table lists what Claude Code puts in each field. The fields from `model` through `over_limit` describe the session as a whole, and the collection fields attribute tokens to individual items.

| Field            | Type                                                      | Description                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`          | `string`                                                  | The main loop's model Claude Code computed the usage for, not a subagent's                                                                                                                                                                                                                        |
| `total_tokens`   | `number`                                                  | Claude Code's estimate of the tokens in use. Not clamped to the window, so it can exceed `raw_max_tokens` when the session is over the limit                                                                                                                                                      |
| `raw_max_tokens` | `number`                                                  | The model's context window, or the lower [auto-compact window](/docs/en/model-config#context-window-and-auto-compaction) when one applies, such as one you set or the 200K boundary Claude Code applies to some models with a 1M-token window. Claude Code measures `total_tokens` against this window |
| `percentage`     | `number`                                                  | `total_tokens` as a rounded percentage of `raw_max_tokens`, so it can exceed 100 when the session is over the limit                                                                                                                                                                               |
| `over_limit`     | `object`                                                  | Present only when `total_tokens` exceeds `raw_max_tokens`. `tokens_over` is the amount over, and `kind` says how Claude Code resolved the window                                                                                                                                                  |
| `categories`     | [`SDKContextUsageCategory`](#sdkcontextusagecategory)`[]` | One entry per row of the usage-by-category breakdown                                                                                                                                                                                                                                              |
| `mcp_tools`      | `object[]`                                                | Tokens attributed to each MCP tool, with its wire name, such as `mcp__linear__create_issue`, and its `server_name`                                                                                                                                                                                |
| `memory_files`   | `object[]`                                                | Tokens attributed to each loaded memory file, with its `path` and a source label such as `Project` or `User` in `type`                                                                                                                                                                            |
| `agents`         | `object[]`                                                | Tokens attributed to each custom subagent definition, with a source identifier such as `projectSettings`, `userSettings`, or `plugin`. Built-in subagents aren't listed                                                                                                                           |
| `skills`         | `object[]`                                                | Tokens attributed to each skill in the skill listing, with a source identifier and, for plugin skills, the plugin's name in `plugin_name`. Absent when no skills contribute tokens                                                                                                                |

`over_limit.kind` records how Claude Code resolved the window, not whether the API accepts the next request:

* `hard_limit`: the window is what Claude Code believes to be the model's own limit, past which the API refuses requests
* `compaction_window`: the window is a compaction-policy window, which may or may not coincide with the model's limit

Claude Code evolves the type additively, adding new data as optional fields rather than reshaping existing ones. Read the fields you know and ignore any you don't recognize.

### `SDKContextUsageCategory`

One row of the `/context` usage-by-category breakdown.

```typescript theme={null}
type SDKContextUsageCategory = {
  name: string;
  tokens: number;
  kind: "used" | "free" | "buffer" | "deferred";
};
```

The table lists what Claude Code puts in each field of a row.

| Field    | Type     | Description                                                                                              |
| -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `name`   | `string` | The row's display name as `/context` prints it, such as `Messages`. Classify rows by `kind`, not by name |
| `tokens` | `number` | The row's token count. Rows can carry zero tokens                                                        |
| `kind`   | `string` | What the row represents: `used`, `free`, `buffer`, or `deferred`                                         |

Each `kind` value says what the row's tokens are:

* `used`: content that occupies the context window
* `free`: the remaining window
* `buffer`: the compaction reserve
* `deferred`: tool schemas Claude Code holds out of the window and excludes from the usage calculation, listed for awareness

### `SDKMessageOrigin`

Provenance of a user-role message. This appears as `origin` on [`SDKUserMessage`](#sdkusermessage) and is forwarded onto the corresponding [`SDKResultMessage`](#sdkresultmessage) so you can tell what triggered a given turn.

```typescript theme={null}
type SDKMessageOrigin =
  | { kind: "human" }
  | { kind: "channel"; server: string }
  | {
      kind: "peer";
      from: string;
      fromMode?: "bypass" | "prompting";
      name?: string;
      fromSession?: string;
      senderTaskId?: string;
      body?: string;
      verifiedPeerPid?: number;
    }
  | {
      kind: "task-notification";
      subkind?: "scheduled-trigger" | "peer-send-message";
    }
  | { kind: "coordinator" }
  | { kind: "auto-continuation" }
  | { kind: "unclassified" };
```

| `kind`              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human`             | Direct input from the end user. If your application forwards what the user typed as a user message, set its `origin` to `{ kind: "human" }` explicitly: Claude Code treats a user message with no `origin` as unattributed, and checks that require a human-typed prompt, such as the [`ultracode` workflow keyword](/docs/en/workflows#ask-for-a-workflow-in-your-prompt), don't accept it. Before v2.1.210, Claude Code treated an absent `origin` on a user message as human input. |
| `channel`           | Message arriving on a [channel](/docs/en/channels). `server` is the source MCP server name.                                                                                                                                                                                                                                                                                                                                                                                            |
| `peer`              | Message from another agent: an in-process [teammate](/docs/en/agent-teams) or a [cross-session peer](/docs/en/cross-session-messaging), another of your Claude Code sessions. See [Peer origin fields](#peer-origin-fields) for the per-field semantics and the trust model.                                                                                                                                                                                                                |
| `task-notification` | Synthetic turn injected for a delivery that arrives without a fresh user prompt, such as a finished background task; see [`SDKTaskNotificationMessage`](#sdktasknotificationmessage) for that arm. The optional `subkind` marks what raised the notification. See [Task-notification subkinds](#task-notification-subkinds).                                                                                                                                                      |
| `coordinator`       | Message from a team coordinator in an [agent team](/docs/en/agent-teams).                                                                                                                                                                                                                                                                                                                                                                                                              |
| `auto-continuation` | Synthetic turn injected when the session continues without fresh user input, such as a command result that triggers a follow-up prompt.                                                                                                                                                                                                                                                                                                                                           |
| `unclassified`      | Injected turn whose origin couldn't be determined. Requires Claude Code v2.1.223 or later. When Claude Code receives an [`SDKUserMessage`](#sdkusermessage) with `isSynthetic: true` and can't classify it as any other `kind`, it sets this kind as the message arrives and frames the turn to the model as a non-user source rather than treating it as human input. Your application shouldn't set this value.                                                                 |

### Task-notification subkinds

When Claude Code delivers a task notification into a session, it sets `subkind` on the notification's `origin` only if Anthropic servers verified where that notification came from. `subkind` requires Claude Code v2.1.213 or later, and it takes one of two values:

* `scheduled-trigger`: the notification is a [routine](/docs/en/routines)'s stored prompt, delivered because one of the routine's triggers fired: its schedule, its [API trigger](/docs/en/routines#add-an-api-trigger), its [GitHub trigger](/docs/en/routines#add-a-github-trigger), or **Run now**. Claude Code frames these to the model as the session's assigned task, with a different notice from the [notice that other task notifications carry](#sdktasknotificationmessage).
* `peer-send-message`: the notification is a message that another of your sessions sent with the server-side `send_message` tool that [Claude Code on the web](/docs/en/claude-code-on-the-web) sessions use to message each other, not the [cross-session `SendMessage` tool](/docs/en/cross-session-messaging), and Anthropic servers verified that both sessions belong to the same private group of sessions. Requires Claude Code v2.1.224 or later. A `send_message` delivery the servers didn't verify that way gets no subkind.

Every other task notification has no `subkind`. That includes [scheduled tasks](/docs/en/scheduled-tasks) that fire on your own machine, [PR activity](/docs/en/claude-code-on-the-web#how-claude-responds-to-pr-activity) delivered into a session, and background events such as a finished task. Messages from the [cross-session `SendMessage` tool](/docs/en/cross-session-messaging) aren't task notifications at all: whether they come from a session on the same machine or through Anthropic servers from another machine, Claude Code gives them `kind: "peer"` and the [peer origin fields](#peer-origin-fields).

### Peer origin fields

A `peer` origin identifies which agent sent the message: an in-process [teammate](/docs/en/agent-teams) sending to `main` with `SendMessage`, or a [cross-session peer](/docs/en/cross-session-messaging), another of your Claude Code sessions. A cross-session peer can run on the same machine, or on [another of your machines](/docs/en/cross-session-messaging#message-sessions-on-other-machines) or [Claude Code on the web](/docs/en/claude-code-on-the-web) when its message arrives through Remote Control. The two kinds of sender fill the fields differently:

* `from`: the teammate's name, or the sender address for a cross-session peer. For a [one-way cross-machine message](/docs/en/cross-session-messaging#message-sessions-on-other-machines), the sender has no reply address and `from` is `"unknown"`. The value is sender-authored; `verifiedPeerPid` is the verified identity.
* `fromMode`: the sending session's permission class, `bypass` or `prompting`, declared by a host that relays a peer message between your sessions, such as the [desktop app](/docs/en/desktop#work-across-sessions). Claude Code reads it in the receiving session when it applies the [inbound controls](/docs/en/cross-session-messaging#control-inbound-messages). Requires Agent SDK v0.3.234 or later.
* `senderTaskId`: the teammate's task ID. Absent for a cross-session peer.
* `name`: the sender's display name, normalized by Claude Code: it strips Unicode control, format, surrogate, and line or paragraph separator code points, then trims the result and caps it at 64 code points with an ellipsis. Requires Claude Code v2.1.205 or later.
* `body`: the decoded message body with the peer envelope stripped, byte-exact with what the model sees. Always present for a teammate message; for a cross-session peer, present only when the turn is exactly one peer envelope formed by Claude Code. Render `name` and `body` instead of re-parsing the message text. Requires Claude Code v2.1.205 or later.
* `fromSession`: the sender's host-openable session ID, set by the sender's host so your UI can link back to the sending session. Like `from`, it is sender-asserted: use it as a navigation target only, and don't treat it as proof of the sender's identity. Requires Claude Code v2.1.216 or later.
* `verifiedPeerPid`: the process ID of the process that connected to this session's cross-session messaging socket, verified by the kernel and read from the connection itself, never from the payload. Use it, not `from`, to identify the sender: `from` is forgeable by any same-user process. The field is absent when Claude Code can't verify it, such as on Windows or non-socket ingress, so an absent value means the sender is unverified. For relayed traffic it identifies the relay rather than the message's author, and process IDs are recyclable, so treat it as provenance rather than an authentication token. Requires Claude Code v2.1.216 or later.

## Hook Types

For a comprehensive guide on using hooks with examples and common patterns, see the [Hooks guide](/docs/en/agent-sdk/hooks).

### `HookEvent`

Available hook events.

```typescript theme={null}
type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "Notification"
  | "UserPromptSubmit"
  | "UserPromptExpansion"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "StopFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "PermissionRequest"
  | "PermissionDenied"
  | "Setup"
  | "TeammateIdle"
  | "TaskCreated"
  | "TaskCompleted"
  | "Elicitation"
  | "ElicitationResult"
  | "ConfigChange"
  | "DirectoryAdded"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "InstructionsLoaded"
  | "CwdChanged"
  | "FileChanged"
  | "MessageDisplay";
```

### `HookCallback`

Hook callback function type.

```typescript theme={null}
type HookCallback = (
  input: HookInput, // Union of all hook input types
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### `HookCallbackMatcher`

Hook configuration with optional matcher.

```typescript theme={null}
interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number; // Timeout in seconds for all hooks in this matcher
}
```

### `HookInput`

Union type of all hook input types.

```typescript theme={null}
type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PostToolBatchHookInput
  | PermissionDeniedHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | UserPromptExpansionHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PermissionRequestHookInput
  | SetupHookInput
  | TeammateIdleHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | ConfigChangeHookInput
  | InstructionsLoadedHookInput
  | DirectoryAddedHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | CwdChangedHookInput
  | FileChangedHookInput
  | MessageDisplayHookInput;
```

### `BaseHookInput`

Base interface that all hook input types extend.

```typescript theme={null}
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt_id?: string;
  permission_mode?: string;
  effort?: { level: string };
  agent_id?: string;
  agent_type?: string;
};
```

The `prompt_id` field is a UUID identifying the user prompt currently being processed. It matches the [`prompt.id` attribute on OpenTelemetry events](/docs/en/monitoring-usage#event-correlation-attributes) and is absent until the first user input. Requires Claude Code v2.1.196 or later.

#### `PreToolUseHookInput`

```typescript theme={null}
type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};
```

#### `PostToolUseHookInput`

```typescript theme={null}
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
};
```

#### `PostToolUseFailureHookInput`

```typescript theme={null}
type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;
  duration_ms?: number;
};
```

#### `PostToolBatchHookInput`

Fires once after every tool call in a batch has resolved, before the next model request. `tool_response` carries the serialized `tool_result` content the model sees; the shape differs from `PostToolUseHookInput`'s structured `Output` object.

```typescript theme={null}
type PostToolBatchHookInput = BaseHookInput & {
  hook_event_name: "PostToolBatch";
  tool_calls: PostToolBatchToolCall[];
};

type PostToolBatchToolCall = {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  tool_response?: unknown;
};
```

#### `PermissionDeniedHookInput`

```typescript theme={null}
type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: "PermissionDenied";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  reason: string;
};
```

#### `NotificationHookInput`

```typescript theme={null}
type NotificationHookInput = BaseHookInput & {
  hook_event_name: "Notification";
  message: string;
  title?: string;
  notification_type: string;
};
```

#### `UserPromptSubmitHookInput`

```typescript theme={null}
type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
  session_title?: string;
};
```

#### `UserPromptExpansionHookInput`

```typescript theme={null}
type UserPromptExpansionHookInput = BaseHookInput & {
  hook_event_name: "UserPromptExpansion";
  expansion_type: "slash_command" | "mcp_prompt";
  command_name: string;
  command_args: string;
  command_source?: string;
  prompt: string;
};
```

#### `SessionStartHookInput`

```typescript theme={null}
type SessionStartHookInput = BaseHookInput & {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | "fork";
  agent_type?: string;
  model?: string;
  session_title?: string;
};
```

#### `SessionEndHookInput`

```typescript theme={null}
type SessionEndHookInput = BaseHookInput & {
  hook_event_name: "SessionEnd";
  reason: ExitReason; // String from EXIT_REASONS array
};
```

#### `StopHookInput`

```typescript theme={null}
type StopHookInput = BaseHookInput & {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
  background_tasks?: BackgroundTaskSummary[];
  session_crons?: SessionCronSummary[];
};
```

#### `StopFailureHookInput`

```typescript theme={null}
type StopFailureHookInput = BaseHookInput & {
  hook_event_name: "StopFailure";
  error: SDKAssistantMessageError;
  error_details?: string;
  last_assistant_message?: string;
};
```

#### `SubagentStartHookInput`

```typescript theme={null}
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
};
```

#### `SubagentStopHookInput`

```typescript theme={null}
type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
  last_assistant_message?: string;
  background_tasks?: BackgroundTaskSummary[];
  session_crons?: SessionCronSummary[];
};

type BackgroundTaskSummary = {
  id: string;
  type: string;
  status: string;
  description: string;
  command?: string;
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
};

type SessionCronSummary = {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
};
```

#### `PreCompactHookInput`

```typescript theme={null}
type PreCompactHookInput = BaseHookInput & {
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions: string | null;
};
```

#### `PostCompactHookInput`

```typescript theme={null}
type PostCompactHookInput = BaseHookInput & {
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
};
```

#### `PermissionRequestHookInput`

```typescript theme={null}
type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
};
```

#### `SetupHookInput`

```typescript theme={null}
type SetupHookInput = BaseHookInput & {
  hook_event_name: "Setup";
  trigger: "init" | "maintenance";
};
```

#### `TeammateIdleHookInput`

```typescript theme={null}
type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: "TeammateIdle";
  teammate_name: string;
  /** @deprecated since v2.1.178. Carries the session-derived team name; will be removed. */
  team_name: string;
};
```

#### `TaskCreatedHookInput`

```typescript theme={null}
type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: "TaskCreated";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  /** @deprecated since v2.1.178. Carries the session-derived team name; will be removed. */
  team_name?: string;
};
```

#### `TaskCompletedHookInput`

```typescript theme={null}
type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: "TaskCompleted";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  /** @deprecated since v2.1.178. Carries the session-derived team name; will be removed. */
  team_name?: string;
};
```

#### `ElicitationHookInput`

```typescript theme={null}
type ElicitationHookInput = BaseHookInput & {
  hook_event_name: "Elicitation";
  mcp_server_name: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
};
```

#### `ElicitationResultHookInput`

```typescript theme={null}
type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: "ElicitationResult";
  mcp_server_name: string;
  elicitation_id?: string;
  mode?: "form" | "url";
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};
```

#### `ConfigChangeHookInput`

```typescript theme={null}
type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: "ConfigChange";
  source:
    | "user_settings"
    | "project_settings"
    | "local_settings"
    | "policy_settings"
    | "skills";
  file_path?: string;
};
```

#### `InstructionsLoadedHookInput`

```typescript theme={null}
type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: "InstructionsLoaded";
  file_path: string;
  memory_type: "User" | "Project" | "Local" | "Managed";
  load_reason:
    | "session_start"
    | "nested_traversal"
    | "path_glob_match"
    | "include"
    | "compact";
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
};
```

#### `DirectoryAddedHookInput`

```typescript theme={null}
type DirectoryAddedHookInput = BaseHookInput & {
  hook_event_name: "DirectoryAdded";
  directory: string;
  source: "slash_command" | "register_repo_root";
};
```

`directory` is the absolute path of the directory that was added. `source` is `"slash_command"` when `/add-dir` added it and `"register_repo_root"` when the SDK control request did.

#### `WorktreeCreateHookInput`

```typescript theme={null}
type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: "WorktreeCreate";
  name: string;
};
```

#### `WorktreeRemoveHookInput`

```typescript theme={null}
type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: "WorktreeRemove";
  worktree_path: string;
};
```

#### `CwdChangedHookInput`

```typescript theme={null}
type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: "CwdChanged";
  old_cwd: string;
  new_cwd: string;
};
```

#### `FileChangedHookInput`

```typescript theme={null}
type FileChangedHookInput = BaseHookInput & {
  hook_event_name: "FileChanged";
  file_path: string;
  event: "change" | "add" | "unlink";
};
```

#### `MessageDisplayHookInput`

```typescript theme={null}
type MessageDisplayHookInput = BaseHookInput & {
  hook_event_name: "MessageDisplay";
  turn_id: string;
  message_id: string;
  index: number;
  final: boolean;
  delta: string;
};
```

### `HookJSONOutput`

Hook return value.

```typescript theme={null}
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;
```

#### `AsyncHookJSONOutput`

```typescript theme={null}
type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;
};
```

#### `SyncHookJSONOutput`

```typescript theme={null}
type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  systemMessage?: string;
  /**
   * A terminal escape sequence (e.g. OSC 9 / OSC 777 desktop-notification)
   * for Claude Code to emit on your behalf. Only notification/title OSCs
   * (0, 1, 2, 9, 99, 777) and BEL are permitted; a value containing
   * anything else is ignored as a whole. Only the interactive CLI emits
   * it; the SDK ignores the field.
   */
  terminalSequence?: string;
  reason?: string;
  hookSpecificOutput?:
    | {
        hookEventName: "PreToolUse";
        permissionDecision?: "allow" | "deny" | "ask" | "defer";
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
        additionalContext?: string;
      }
    | {
        hookEventName: "UserPromptSubmit";
        additionalContext?: string;
        sessionTitle?: string;
        /** When decision is "block", omit the original prompt from the block message. */
        suppressOriginalPrompt?: boolean;
      }
    | {
        hookEventName: "UserPromptExpansion";
        additionalContext?: string;
      }
    | {
        hookEventName: "SessionStart";
        additionalContext?: string;
        initialUserMessage?: string;
        sessionTitle?: string;
        watchPaths?: string[];
        /**
         * Re-scan skill and command directories after SessionStart hooks
         * complete, so skills installed by the hook are available in the
         * same session.
         */
        reloadSkills?: boolean;
      }
    | {
        hookEventName: "Setup";
        additionalContext?: string;
      }
    | {
        hookEventName: "SubagentStart";
        additionalContext?: string;
      }
    | {
        hookEventName: "PostToolUse";
        additionalContext?: string;
        /**
         * Short note about this tool call's result for the auto mode
         * permission classifier. Capped at 2000 characters, shared across
         * all hooks that respond to the same call; honored on synchronous
         * hook responses only. Don't copy untrusted tool output into it.
         */
        classifierContext?: string;
        updatedToolOutput?: unknown;
        /** @deprecated Use `updatedToolOutput`, which works for all tools. */
        updatedMCPToolOutput?: unknown;
      }
    | {
        hookEventName: "PostToolUseFailure";
        additionalContext?: string;
      }
    | {
        hookEventName: "PostToolBatch";
        additionalContext?: string;
      }
    | {
        hookEventName: "Stop";
        additionalContext?: string;
      }
    | {
        hookEventName: "SubagentStop";
        additionalContext?: string;
      }
    | {
        hookEventName: "PermissionDenied";
        retry?: boolean;
      }
    | {
        hookEventName: "Notification";
        additionalContext?: string;
      }
    | {
        hookEventName: "PermissionRequest";
        decision:
          | {
              behavior: "allow";
              updatedInput?: Record<string, unknown>;
              updatedPermissions?: PermissionUpdate[];
            }
          | {
              behavior: "deny";
              message?: string;
              interrupt?: boolean;
            };
      }
    | {
        hookEventName: "Elicitation";
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      }
    | {
        hookEventName: "ElicitationResult";
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      }
    | {
        hookEventName: "CwdChanged";
        watchPaths?: string[];
      }
    | {
        hookEventName: "FileChanged";
        watchPaths?: string[];
      }
    | {
        hookEventName: "WorktreeCreate";
        worktreePath: string;
      }
    | {
        hookEventName: "MessageDisplay";
        /** Text displayed in place of the delta. Omit (or return the delta unchanged) to display the original. */
        displayContent?: string;
      };
};
```

## Tool Input Types

Documentation of input schemas for all built-in Claude Code tools. These types are exported from `@anthropic-ai/claude-agent-sdk` and can be used for type-safe tool interactions.

### `ToolInputSchemas`

Union of tool input types exported from `@anthropic-ai/claude-agent-sdk`; members include:

```typescript theme={null}
type ToolInputSchemas =
  | AgentInput
  | ArtifactInput
  | AskUserQuestionInput
  | BashInput
  | CronCreateInput
  | CronDeleteInput
  | CronListInput
  | EnterPlanModeInput
  | EnterWorktreeInput
  | ExitPlanModeInput
  | ExitWorktreeInput
  | FileEditInput
  | FileReadInput
  | FileWriteInput
  | GlobInput
  | GrepInput
  | ListMcpResourcesInput
  | McpInput
  | MonitorInput
  | NotebookEditInput
  | ProjectsInput
  | PushNotificationInput
  | ReadMcpResourceDirInput
  | ReadMcpResourceInput
  | RefreshMcpToolsInput
  | RemoteTriggerInput
  | REPLInput
  | ReportFindingsInput
  | ScheduleWakeupInput
  | ShowOnboardingRolePickerInput
  | TaskCreateInput
  | TaskGetInput
  | TaskListInput
  | TaskOutputInput
  | TaskStopInput
  | TaskUpdateInput
  | TodoWriteInput
  | WebFetchInput
  | WebSearchInput
  | WorkflowInput;
```

### Agent

**Tool name:** `Agent`. The previous name `Task` is still accepted as an alias, and the `tools` array in the [`SDKSystemMessage`](#sdksystemmessage) init message currently lists this tool as `Task` for backward compatibility.

<Note>
  The `mode` field is deprecated and ignored on Claude Code v2.1.212 or later: subagents [inherit the parent session's permission mode](/docs/en/agent-sdk/permissions#available-modes), and a subagent definition's [`permissionMode`](#agentdefinition) can override it, except when the parent uses `bypassPermissions`, `acceptEdits`, or `auto`, and Claude Code ignores a definition's `permissionMode: "bypassPermissions"` when bypass mode is disabled by [`permissions.disableBypassPermissionsMode`](/docs/en/permissions#managed-settings).
</Note>

```typescript theme={null}
type AgentInput = {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: "sonnet" | "opus" | "haiku" | "fable";
  run_in_background?: boolean;
  name?: string;
  team_name?: string; // Deprecated; ignored
  mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan"; // Deprecated; ignored. Subagents inherit the parent session's permission mode; agent-definition frontmatter may override it
  isolation?: "worktree" | "remote";
};
```

Launches a new agent to handle complex, multi-step tasks autonomously.

### AskUserQuestion

**Tool name:** `AskUserQuestion`

```typescript theme={null}
type AskUserQuestionInput = {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    multiSelect: boolean;
  }>;
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  metadata?: { source?: string };
};
```

Asks the user clarifying questions during execution. See [Handle approvals and user input](/docs/en/agent-sdk/user-input#handle-clarifying-questions) for usage details.

### Bash

**Tool name:** `Bash`

```typescript theme={null}
type BashInput = {
  command: string;
  timeout?: number; // milliseconds, max 600000; higher values are clamped to the max
  description?: string;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
};
```

Executes Bash commands with optional timeout and background execution. The working directory persists between commands; shell state such as exported environment variables doesn't.

### Monitor

**Tool name:** `Monitor`

```typescript theme={null}
type MonitorInput = {
  command?: string;
  ws?: {
    url: string;
    protocols?: string[];
  };
  description: string;
  timeout_ms: number;
  persistent: boolean;
};
```

Runs a background source and delivers each event to Claude so it can react without polling: `command` runs a script and emits one event per stdout line, and `ws` opens a WebSocket and emits one event per text frame. Provide exactly one of `command` or `ws`. The `ws` source requires Claude Code v2.1.195 or later.

Set `persistent: true` for session-length watches such as log tails. When Monitor runs a command, it follows the same permission rules as Bash; a WebSocket watch prompts for approval separately. See the [Monitor tool reference](/docs/en/tools-reference#monitor-tool) for behavior and provider availability. The exported type marks `timeout_ms` and `persistent` as required because the schema fills in their defaults, 300000 and `false`; a call that omits them validates.

### TaskOutput

**Tool name:** `TaskOutput`

<Note>`TaskOutput` is deprecated; prefer `Read` on the task's output file path. The schemas below remain valid for hooks and permission handlers that encounter the tool.</Note>

```typescript theme={null}
type TaskOutputInput = {
  task_id: string;
  block: boolean;
  timeout: number;
};
```

Retrieves output from a running or completed background task.

### Edit

**Tool name:** `Edit`

```typescript theme={null}
type FileEditInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};
```

Performs exact string replacements in files.

### Read

**Tool name:** `Read`

```typescript theme={null}
type FileReadInput = {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
};
```

Reads files from the local filesystem, including text, images, PDFs, and Jupyter notebooks. Use `pages` for PDF page ranges (for example, `"1-5"`).

### Write

**Tool name:** `Write`

```typescript theme={null}
type FileWriteInput = {
  file_path: string;
  content: string;
};
```

Writes a file to the local filesystem, overwriting if it exists.

### Glob

**Tool name:** `Glob`

```typescript theme={null}
type GlobInput = {
  pattern: string;
  path?: string;
};
```

Fast file pattern matching that works with any codebase size.

### Grep

**Tool name:** `Grep`

```typescript theme={null}
type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-o"?: boolean; // print only the matched parts of each line; requires output_mode: "content"
  "-n"?: boolean;
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
};
```

Powerful search tool built on ripgrep with regex support.

### TaskStop

**Tool name:** `TaskStop`

```typescript theme={null}
type TaskStopInput = {
  task_id?: string;
  shell_id?: string; // Deprecated: use task_id
};
```

Stops a running background task or shell by ID. As of v2.1.198, `task_id` also accepts an agent-team teammate or a named background agent by agent ID or name.

### NotebookEdit

**Tool name:** `NotebookEdit`

```typescript theme={null}
type NotebookEditInput = {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: "code" | "markdown";
  edit_mode?: "replace" | "insert" | "delete";
};
```

Edits cells in Jupyter notebook files.

### WebFetch

**Tool name:** `WebFetch`

```typescript theme={null}
type WebFetchInput = {
  url: string;
  prompt: string;
};
```

Fetches content from a URL and processes it with an AI model.

### WebSearch

**Tool name:** `WebSearch`

```typescript theme={null}
type WebSearchInput = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};
```

Searches the web and returns formatted results.

### Workflow

**Tool name:** `Workflow`

```typescript theme={null}
type WorkflowInput = {
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: unknown; // any JSON value; the published typings render this as an object map
  resumeFromRunId?: string;
  title?: string; // ignored; the script's meta block sets the title
  description?: string; // ignored; the script's meta block sets the description
};
```

Runs a [dynamic workflow](/docs/en/workflows): a script that orchestrates many subagents in the background and returns one consolidated result. The `Workflow` tool is available in Agent SDK v0.3.149 and later. At least one of `script`, `name`, or `scriptPath` is required.

| Field             | Type      | Description                                                                                                                                                                                                                                                                          |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `script`          | `string`  | Inline workflow script. Must begin with `export const meta = { name, description }` as a literal, followed by the script body using `agent()`, `parallel()`, `pipeline()`, and `phase()`. An optional `phases` array in `meta` groups agents under named stages in the progress view |
| `name`            | `string`  | Name of a built-in workflow or one saved in `.claude/workflows/`. Resolved to a script                                                                                                                                                                                               |
| `scriptPath`      | `string`  | Path to a workflow script file on disk. Takes precedence over `script` and `name`. Every invocation persists its script and returns the path in the result, so you can edit that file and re-invoke with the same `scriptPath` to iterate                                            |
| `args`            | `unknown` | Input value exposed to the script as the global `args`, for parameterized named workflows such as a research question or a list of file paths. Pass arrays and objects as actual JSON values, not as a JSON-encoded string                                                           |
| `resumeFromRunId` | `string`  | Run ID of a prior `Workflow` invocation to resume. Completed `agent()` calls with unchanged inputs usually return cached results; the rest run live. [Resume after a pause](/docs/en/workflows#resume-after-a-pause) covers which completed calls re-run. Same session only               |
| `title`           | `string`  | Ignored; the script's `meta` block sets the title                                                                                                                                                                                                                                    |
| `description`     | `string`  | Ignored; the script's `meta` block sets the description                                                                                                                                                                                                                              |

### TodoWrite

**Tool name:** `TodoWrite`

```typescript theme={null}
type TodoWriteInput = {
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
  }>;
};
```

Creates and manages a structured task list for tracking progress.

<Note>
  On TypeScript Agent SDK 0.3.233 and later, the following tools aren't available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, or later versions of those families unless you opt in:

  * `TodoWrite`
  * `TaskCreate`
  * `TaskGet`
  * `TaskUpdate`
  * `TaskList`

  On other models, Claude Code provides the Task tools by default and `TodoWrite` only when you set `CLAUDE_CODE_ENABLE_TASKS=0`.

  See [Model availability](/docs/en/agent-sdk/todo-tracking#model-availability) to opt in.
</Note>

### TaskCreate

**Tool name:** `TaskCreate`

```typescript theme={null}
type TaskCreateInput = {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
};
```

Creates a single task and returns its assigned ID.

### TaskUpdate

**Tool name:** `TaskUpdate`

```typescript theme={null}
type TaskUpdateInput = {
  taskId: string;
  status?: "pending" | "in_progress" | "completed" | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
};
```

Patches one task by ID. Set `status` to `"deleted"` to remove it.

### TaskGet

**Tool name:** `TaskGet`

```typescript theme={null}
type TaskGetInput = {
  taskId: string;
};
```

Returns full details for one task, or `null` when the ID is not found.

### TaskList

**Tool name:** `TaskList`

```typescript theme={null}
type TaskListInput = {};
```

Returns a snapshot of all tasks in the current list.

### ExitPlanMode

**Tool name:** `ExitPlanMode`

```typescript theme={null}
type ExitPlanModeInput = {
  /** Deprecated: no longer used. */
  allowedPrompts?: Array<{
    tool: "Bash";
    prompt: string;
  }>;
  [k: string]: unknown;
};
```

Exits plan mode. The `allowedPrompts` field is deprecated and ignored; Claude Code still accepts it so existing callers and transcripts validate. Before v2.1.205, it requested prompt-based Bash permissions for implementing the plan.

### ListMcpResources

**Tool name:** `ListMcpResourcesTool`

```typescript theme={null}
type ListMcpResourcesInput = {
  server?: string;
};
```

Lists available MCP resources from connected servers.

### ReadMcpResource

**Tool name:** `ReadMcpResourceTool`

```typescript theme={null}
type ReadMcpResourceInput = {
  server: string;
  uri: string;
};
```

Reads a specific MCP resource from a server.

### EnterWorktree

**Tool name:** `EnterWorktree`

```typescript theme={null}
type EnterWorktreeInput = {
  name?: string;
  path?: string;
};
```

Creates and enters a temporary git worktree for isolated work. Pass `path` to switch into an existing worktree instead of creating a new one. On first entry the target must be a registered worktree of the current repository or, in a multi-repo workspace, of a repository nested inside it; from within a worktree session it must be under `.claude/worktrees/` of the session's repository. `name` and `path` are mutually exclusive.

### ExitWorktree

**Tool name:** `ExitWorktree`

```typescript theme={null}
type ExitWorktreeInput = {
  action: "keep" | "remove";
  discard_changes?: boolean;
};
```

Exits the current git worktree and returns to the original working directory. The `keep` action leaves the worktree and branch on disk, while `remove` deletes both. `discard_changes` must be `true` when removing a worktree that has uncommitted files or unmerged commits.

### EnterPlanMode

**Tool name:** `EnterPlanMode`

```typescript theme={null}
type EnterPlanModeInput = {};
```

Enters plan mode, where Claude researches and presents a plan before making changes.

### CronCreate

**Tool name:** `CronCreate`

```typescript theme={null}
type CronCreateInput = {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
};
```

Schedules a prompt to run on a 5-field cron schedule in local time. Set `recurring` to `false` to fire once at the next match. Jobs are session-scoped by default: starting a fresh conversation clears them, and resuming with `--resume` or `--continue` restores jobs that haven't expired. See [Scheduled tasks](/docs/en/scheduled-tasks).

Setting `durable` to `true` requests persistence to `.claude/scheduled_tasks.json` so the job survives restarts. Durable scheduling isn't available in every session: when it isn't, Claude Code accepts `durable: true` but creates the job session-only. Read the output's `durable` field to see whether the job persisted.

### CronDelete

**Tool name:** `CronDelete`

```typescript theme={null}
type CronDeleteInput = {
  id: string;
};
```

Deletes a scheduled cron job by the ID returned from `CronCreate`.

### CronList

**Tool name:** `CronList`

```typescript theme={null}
type CronListInput = {};
```

Lists the scheduled cron jobs: durable jobs from `.claude/scheduled_tasks.json` and session-only jobs from the current session.

### ScheduleWakeup

**Tool name:** `ScheduleWakeup`

```typescript theme={null}
type ScheduleWakeupInput = {
  delaySeconds?: number;
  reason?: string;
  prompt?: string;
  stop?: boolean;
};
```

Schedules a one-shot wake-up that fires the given prompt after a delay. This tool backs the self-paced `/loop` command. The runtime clamps `delaySeconds` to between 60 and 3600 seconds. The `delaySeconds`, `reason`, and `prompt` fields are required unless `stop` is true. Setting `stop: true` cancels the pending wakeup and ends the self-paced `/loop`. The `stop` field requires Claude Code v2.1.202 or later. See the [ScheduleWakeup row in the tools reference](/docs/en/tools-reference) for availability; it isn't available on Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry, nor when you turn off [feature-flag fetching](/docs/en/env-vars#features-that-need-feature-flag-fetching).

### RemoteTrigger

**Tool name:** `RemoteTrigger`

```typescript theme={null}
type RemoteTriggerInput = {
  action:
    | "list"
    | "get"
    | "create"
    | "update"
    | "run"
    | "create_webhook_trigger"
    | "list_runs"
    | "get_run_log";
  trigger_id?: string;
  session_id?: string;
  cursor?: string;
  body?: {
    [k: string]: unknown;
  };
};
```

Manages [Routines](/docs/en/routines), the scheduled and triggered Claude Code runs hosted in the cloud. This tool backs the `/schedule` command. `trigger_id` is required for the `get`, `update`, `run`, and `list_runs` actions. `body` is required for `create`, `update`, and `create_webhook_trigger`, and optional for `run`.

`create_webhook_trigger` attaches an event source to an existing routine, such as a [GitHub event](/docs/en/routines#add-a-github-trigger) that fires it. The `body` names the source, the events, and the routine to fire. Requires Claude Code v2.1.225 or later.

`list_runs` lists a routine's recent runs, and `get_run_log` reads one run's log. `session_id` names the run to read, from a `list_runs` result, and `cursor` pages through either action's results. Both actions require Claude Code v2.1.227 or later.

This tool is available only when the session is authenticated with a claude.ai account on a plan with Routines enabled, and is absent when your organization's policy disables [Claude Code on the web](/docs/en/claude-code-on-the-web) or when you turn off [feature-flag fetching](/docs/en/env-vars#features-that-need-feature-flag-fetching). On Claude Code v2.1.227 or later, the tool is also absent when an Owner has [turned off routines for the organization](/docs/en/routines#routines-are-disabled-by-your-organizations-policy). Before v2.1.227, a session with only the routines toggle turned off still showed the tool, and the server denied its calls.

### PushNotification

**Tool name:** `PushNotification`

```typescript theme={null}
type PushNotificationInput = {
  message: string;
  status: "proactive";
};
```

Sends a proactive push notification to the user. Keep `message` under 200 characters because mobile operating systems truncate longer text. See the [PushNotification row in the tools reference](/docs/en/tools-reference) for provider availability; push delivery runs through Anthropic-hosted infrastructure that isn't accessible from Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry.

### REPL

**Tool name:** `REPL`

```typescript theme={null}
type REPLInput = {
  code: string;
  description?: string;
  timeout?: number;
};
```

Executes JavaScript code in a persistent REPL. State persists across calls and top-level await is supported. `timeout` is in milliseconds, with a default of 30000 and a maximum of 600000.

The types are exported, but the tool is off in SDK sessions unless you set `CLAUDE_CODE_REPL=1` in the [`env` option](#options). It also requires the Bun-based `claude` executable that the native installer provides.

### ReportFindings

**Tool name:** `ReportFindings`

```typescript theme={null}
type ReportFindingsInput = {
  level?: "low" | "medium" | "high" | "xhigh" | "max";
  findings: Array<{
    file: string;
    line?: number;
    summary: string;
    failure_scenario: string;
    short_summary?: string;
    category?: string;
    verdict?: "CONFIRMED" | "PLAUSIBLE";
    outcome?: "fixed" | "skipped" | "no_change_needed";
  }>;
};
```

Reports code-review findings as a structured list so Claude Code can render them instead of printing them as text. `level` is the effort level the review ran at. Findings are ordered most-severe first, with at most 32 per call, and the array is empty when none survived. Requires Claude Code v2.1.196 or later.

Each finding carries these fields:

* `file`: repo-relative path the finding is in. The optional `line` is the 1-indexed line it anchors to.
* `summary`: one-sentence statement of the defect. `failure_scenario` describes the concrete inputs and state that lead to the wrong output or crash.
* `short_summary`: optional compressed label of at most 60 characters for compact display. Requires Claude Code v2.1.212 or later.
* `category`: optional short kebab-case slug of the finding type, such as `correctness` or `test-coverage`. Requires Claude Code v2.1.199 or later.
* `verdict`: set when a verify pass ran; absent on inline-only reviews.
* `outcome`: set only when re-reporting after applying fixes.

### Artifact

**Tool name:** `Artifact`

```typescript theme={null}
type ArtifactInput = {
  action?: "publish" | "list";
  file_path?: string;
  favicon?: string;
  limit?: number;
  scope?: "mine" | "shared" | "all";
  title?: string;
  description?: string;
  label?: string;
  url?: string;
  force?: boolean;
  capabilities?: Record<string, unknown>;
  contract?: "latest" | string;
};
```

Publishes a local `.html` or `.md` file as a hosted artifact page, or lists the user's published artifacts. Omit `action` or pass `"publish"` to publish `file_path`, which is required for the publish action along with `favicon`, one or two emoji for the browser tab. `title` names the published page in the browser tab and gallery when the HTML file has no `<title>` tag. `url` targets an existing artifact to update in place instead of minting a new one.

`force` is a last-resort overwrite that discards a newer version another session published. On a conflict, the failed publish returns the newer content; Claude merges its changes onto that content, or re-reads the artifact, and publishes again. Pass `force` only when the user explicitly asks to discard that version.

Pass `"list"` to enumerate the user's published artifacts; only `limit` and `scope` may accompany it. `scope` defaults to `"mine"`, which lists artifacts the user owns; `"shared"` lists artifacts other people shared with the user, and `"all"` lists both.

* `capabilities`: the runtime capabilities the published page uses, keyed by capability name, such as the [connectors the page may call](/docs/en/artifacts#pull-live-data-with-mcp-connectors). The artifact service validates the declaration and rejects a publish that names a capability the account can't use or gives one an invalid config. Pass `{}` to clear a stored declaration, and omit the field on a redeploy to keep it. Requires Agent SDK v0.3.235 or later.
* `contract`: the runtime version the published page runs against. Omit it to keep the artifact's current version, pass `"latest"` to upgrade, or pass a specific version to pin or roll back. Requires Agent SDK v0.3.235 or later.

The types are exported, but the tool is off by default in Agent SDK sessions. Publishing also requires every condition in the [artifacts availability table](/docs/en/artifacts#availability), which sessions authenticated with an API key don't meet.

### Projects

**Tool name:** `Projects`

```typescript theme={null}
type ProjectsInput = {
  method:
    | "project_info"
    | "project_read"
    | "project_search"
    | "project_write"
    | "project_delete";
  path?: string;
  content?: string;
  local_path?: string;
  present_to_user?: boolean;
  query?: string;
  n?: number;
};
```

Reads and writes the claude.ai Project attached to the session. Dispatches on `method`:

* `project_info`: returns project metadata and the doc list.
* `project_read`: reads one doc by `path`.
* `project_search`: queries the project's knowledge base with `query`. `n` caps the hits and defaults to 5.
* `project_write`: creates or replaces a doc at `path` from exactly one of `content`, which carries inline text, or `local_path`, which names a file inside the working directory. `present_to_user: true` marks the written doc as the deliverable the user needs to see.
* `project_delete`: deletes a doc by `path`.

### ReadMcpResourceDir

**Tool name:** `ReadMcpResourceDirTool`

```typescript theme={null}
type ReadMcpResourceDirInput = {
  server: string;
  uri: string;
};
```

Lists the direct children of a directory resource on an MCP server. Only usable against a server that has declared support for directory listing; the listing isn't recursive. Directory listing isn't enabled in every session: when it's off, the call returns an empty `resources` list and the `error` field reports that directory listing isn't enabled.

### RefreshMcpTools

**Tool name:** `RefreshMcpTools`

```typescript theme={null}
type RefreshMcpToolsInput = {
  server?: string; // refresh only this server; omit to refresh all connected servers
};
```

Re-queries the tool list of connected MCP servers and applies any changes. The types are exported, but Claude Code registers the tool only when you set `CLAUDE_CODE_ENABLE_REFRESH_MCP_TOOLS=1` in the [`env` option](#options), and only in sessions with at least one MCP server. Requires Claude Code v2.1.211 or later.

### ShowOnboardingRolePicker

**Tool name:** `ShowOnboardingRolePicker`

```typescript theme={null}
type ShowOnboardingRolePickerInput = {};
```

Renders a clickable role-picker chip row during Cowork onboarding so the user can pick their role and get a matching plugin installed. Takes no arguments; the role list is defined by the client. The call blocks until the user responds.

### McpInput

**Tool name:** dynamic MCP tool names of the form `mcp__<server>__<tool>`

```typescript theme={null}
type McpInput = {
  [k: string]: unknown;
};
```

MCP tool arguments are an open object: each server defines its own parameters, so the type places no constraints on field names or values. Consult the server's own tool schema for the fields a specific tool accepts.

## Tool Output Types

Documentation of output schemas for all built-in Claude Code tools. These types are exported from `@anthropic-ai/claude-agent-sdk` and represent the actual response data returned by each tool.

### `ToolOutputSchemas`

Union of tool output types exported from `@anthropic-ai/claude-agent-sdk`; members include:

```typescript theme={null}
type ToolOutputSchemas =
  | AgentOutput
  | ArtifactOutput
  | AskUserQuestionOutput
  | BashOutput
  | CronCreateOutput
  | CronDeleteOutput
  | CronListOutput
  | EnterPlanModeOutput
  | EnterWorktreeOutput
  | ExitPlanModeOutput
  | ExitWorktreeOutput
  | FileEditOutput
  | FileReadOutput
  | FileWriteOutput
  | GlobOutput
  | GrepOutput
  | ListMcpResourcesOutput
  | McpOutput
  | MonitorOutput
  | NotebookEditOutput
  | ProjectsOutput
  | PushNotificationOutput
  | ReadMcpResourceDirOutput
  | ReadMcpResourceOutput
  | RefreshMcpToolsOutput
  | RemoteTriggerOutput
  | REPLOutput
  | ReportFindingsOutput
  | ScheduleWakeupOutput
  | ShowOnboardingRolePickerOutput
  | TaskCreateOutput
  | TaskGetOutput
  | TaskListOutput
  | TaskStopOutput
  | TaskUpdateOutput
  | TodoWriteOutput
  | WebFetchOutput
  | WebSearchOutput
  | WorkflowOutput;
```

### Agent

**Tool name:** `Agent`. The previous name `Task` is still accepted as an alias, and the `tools` array in the [`SDKSystemMessage`](#sdksystemmessage) init message currently lists this tool as `Task` for backward compatibility.

```typescript theme={null}
type AgentOutput =
  | {
      status: "completed";
      agentId: string;
      agentType?: string;
      content: Array<{ type: "text"; text: string; citations?: unknown[] | null }>;
      resolvedModel?: string;
      modelsUsed?: string[];
      totalToolUseCount: number;
      totalDurationMs: number;
      totalTokens: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number | null;
        cache_read_input_tokens: number | null;
        server_tool_use: {
          web_search_requests: number;
          web_fetch_requests: number;
        } | null;
        service_tier: string | null;
        cache_creation: {
          ephemeral_1h_input_tokens: number;
          ephemeral_5m_input_tokens: number;
        } | null;
        inference_geo?: string | null;
        speed?: string | null;
        iterations?: unknown;
        output_tokens_details?: {
          thinking_tokens?: number | null;
        } | null;
      };
      toolStats?: {
        readCount: number;
        searchCount: number;
        bashCount: number;
        editFileCount: number;
        linesAdded: number;
        linesRemoved: number;
        otherToolCount: number;
        frameCount?: number;
      };
      prompt: string;
      worktreePath?: string;
      worktreeBranch?: string;
    }
  | {
      status: "async_launched";
      isAsync?: true;
      agentId: string;
      description: string;
      resolvedModel?: string;
      modelsUsed?: string[];
      prompt: string;
      outputFile: string;
      canReadOutputFile?: boolean;
    }
  | {
      status: "remote_launched";
      taskId: string;
      sessionUrl: string;
      description: string;
      prompt: string;
      outputFile: string;
    };
```

Returns the result from the subagent. Discriminated on the `status` field: `"completed"` for finished tasks, `"async_launched"` for background tasks, and `"remote_launched"` for tasks Claude Code dispatched to a remote cloud session, where `sessionUrl` links to that session and `taskId` identifies it.

On the `completed` variant, `resolvedModel` names the model the subagent started on, which can differ from the requested `model` input when [`availableModels`](/docs/en/model-config#restrict-model-selection) or another override applies. This field requires Claude Code v2.1.174 or later. On `async_launched`, it names the model in use when the task moved to the background.

`modelsUsed` lists the models the subagent used, in order. The field is present only when a mid-run swap happened, and a model appears again when the run swapped back to it. On `async_launched`, the list covers the models used before backgrounding. Both `modelsUsed` and the backgrounding behavior of `resolvedModel` require Claude Code v2.1.212 or later.

If Claude Code [kept the subagent's isolated worktree](/docs/en/worktrees#isolate-subagents-with-worktrees), `worktreePath` on the `completed` result is where to find it. `worktreeBranch` is its branch, present when Claude Code created the worktree with git.

Claude Code fills `usage` and `totalTokens` from the subagent's final API request, not from the whole run, so `usage.service_tier` is the service tier string the API reported on that request. When present, `usage.output_tokens_details.thinking_tokens` is the number of that request's output tokens that were thinking tokens. The `output_tokens_details` field requires TypeScript SDK v0.3.228 or later, which bundles Claude Code v2.1.228.

Before v2.1.207, the published type was narrower. It omitted `worktreePath`, `worktreeBranch`, `citations`, `toolStats.frameCount`, and the `inference_geo`, `speed`, and `iterations` usage fields, and it typed `service_tier` as `"standard" | "priority" | "batch"`. Fields the type marks optional can be absent on results recorded by earlier versions.

### AskUserQuestion

**Tool name:** `AskUserQuestion`

```typescript theme={null}
type AskUserQuestionOutput = {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    multiSelect: boolean;
  }>;
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  afkTimeoutMs?: number;
};
```

Returns the questions asked and the user's answers. `response` is set when the user typed a freeform reply instead of answering the structured questions; when present, Claude receives "The user responded: …" instead of the per-question answer list.

### Bash

**Tool name:** `Bash`

```typescript theme={null}
type BashOutput = {
  stdout: string;
  stderr: string;
  rawOutputPath?: string;
  interrupted: boolean;
  isImage?: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  timedOutAfterMs?: number;
  backgroundCwdHint?: string;
  backgroundEndsWithFinalResponse?: true;
  dangerouslyDisableSandbox?: boolean;
  returnCodeInterpretation?: string;
  noOutputExpected?: boolean;
  structuredContent?: unknown[];
  persistedOutputPath?: string;
  persistedOutputSize?: number;
  staleReadFileStateHint?: string;
  ghRateLimitHint?: string;
  gitOperation?: {
    commit?: { sha: string; kind: "committed" | "amended" | "cherry-picked"; branch?: string };
    push?: { branch: string };
    branch?: { ref: string; action: "merged" | "rebased" };
    pr?: {
      number: number;
      url?: string;
      action: "created" | "edited" | "merged" | "commented" | "closed" | "reopened" | "ready" | "draft" | "auto-merge-enabled" | "auto-merge-disabled";
    };
  };
};
```

The `stdout`, `stderr`, and `backgroundTaskId` fields carry:

| Field              | What it carries                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `stdout`           | The command's stdout and stderr, merged into one interleaved stream                             |
| `stderr`           | Notices the tool itself adds, such as a shell working-directory reset, not the command's stderr |
| `backgroundTaskId` | Present for background commands                                                                 |

`timedOutAfterMs` is the timeout in milliseconds, set when the command reached its timeout and moved to the background rather than starting there explicitly. `backgroundCwdHint` is set when the backgrounded command contained a directory-change builtin such as `cd`, `pushd`, `popd`, or `chdir`, and notes that the session working directory didn't change. Both fields require Claude Code v2.1.210 or later.

When a subagent running in the foreground owns a backgrounded command, Claude Code terminates the command when that subagent gives its final response. Claude Code sets `backgroundEndsWithFinalResponse` to `true` on such commands, and omits the field when the command survives the turn, as commands started by the main conversation or by background subagents do. The field requires Claude Code v2.1.227 or later.

Claude Code sets `gitOperation.commit.branch` to the branch named in git's commit summary line, and omits it for a commit made on a detached HEAD. The field requires Agent SDK v0.3.227 or later. Claude Code reports a `gh pr reopen` command as the `reopened` PR action, which requires Agent SDK v0.3.234 or later.

### Monitor

**Tool name:** `Monitor`

```typescript theme={null}
type MonitorOutput = {
  taskId: string;
  timeoutMs: number;
  persistent?: boolean;
};
```

Returns the background task ID for the running monitor. Use this ID with `TaskStop` to cancel the watch early.

### Edit

**Tool name:** `Edit`

```typescript theme={null}
type FileEditOutput = {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string | null;
  structuredPatch: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  userModified: boolean;
  replaceAll: boolean;
  gitDiff?: {
    filename: string;
    status: "modified" | "added";
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
    repository?: string | null;
  };
};
```

Returns the structured diff of the edit operation.

### Read

**Tool name:** `Read`

```typescript theme={null}
type FileReadOutput =
  | {
      type: "text";
      file: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
        /** True when a whole-file read was auto-paginated because it exceeded the token cap (the content is a partial first page). */
        truncatedByTokenCap?: boolean;
      };
    }
  | {
      type: "image";
      file: {
        base64: string;
        type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        originalSize: number;
        dimensions?: {
          originalWidth?: number;
          originalHeight?: number;
          displayWidth?: number;
          displayHeight?: number;
        };
      };
    }
  | {
      type: "notebook";
      file: {
        filePath: string;
        cells: unknown[];
      };
    }
  | {
      type: "pdf";
      file: {
        filePath: string;
        base64: string;
        originalSize: number;
      };
    }
  | {
      type: "parts";
      file: {
        filePath: string;
        originalSize: number;
        count: number;
        outputDir: string;
      };
    }
  | {
      type: "file_unchanged";
      file: {
        filePath: string;
      };
      /** Set when the dedup matched a startup-seeded entry (CLAUDE.md / nested memory) rather than a prior Read tool_result. */
      source?: "seeded";
    };
```

Returns file contents in a format appropriate to the file type. Discriminated on the `type` field.

### Write

**Tool name:** `Write`

```typescript theme={null}
type FileWriteOutput = {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  originalFile: string | null;
  gitDiff?: {
    filename: string;
    status: "modified" | "added";
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
    repository?: string | null;
  };
  userModified?: boolean;
};
```

Returns the write result with structured diff information.

### Glob

**Tool name:** `Glob`

```typescript theme={null}
type GlobOutput = {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
  totalMatches?: number;
  countIsComplete?: boolean;
};
```

Returns file paths matching the glob pattern, sorted by modification time.

`totalMatches` and `countIsComplete` require Claude Code v2.1.191 or later. `totalMatches` reports the number of matching files before truncation. When `countIsComplete` is false, `totalMatches` is a lower bound because the underlying search truncated its own output.

### Grep

**Tool name:** `Grep`

```typescript theme={null}
type GrepOutput = {
  mode?: "content" | "files_with_matches" | "count";
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  totalFiles?: number;
  totalLines?: number;
  appliedLimit?: number;
  appliedOffset?: number;
};
```

Returns search results. The shape varies by `mode`: file list, content with matches, or match counts. In `count` mode, `numFiles` and `numMatches` are totals over the full result set, not the paginated slice. Before v2.1.208, a `head_limit` or `offset` that truncated the listed entries also truncated those totals.

`totalFiles` requires Claude Code v2.1.208 or later and reports the total number of results before `head_limit` and `offset` pagination in `files_with_matches` mode. `totalLines` requires Claude Code v2.1.210 or later and reports the total number of lines before pagination in `content` mode.

### TaskStop

**Tool name:** `TaskStop`

```typescript theme={null}
type TaskStopOutput = {
  message: string;
  task_id: string;
  task_type: string;
  command?: string;
};
```

Returns confirmation after stopping the background task.

### NotebookEdit

**Tool name:** `NotebookEdit`

```typescript theme={null}
type NotebookEditOutput = {
  new_source: string;
  old_source?: string;
  cell_id?: string;
  cell_type: "code" | "markdown";
  language: string;
  edit_mode: string;
  error?: string;
  notebook_path: string;
  original_file: string;
  updated_file: string;
};
```

Returns the result of the notebook edit with original and updated file contents.

### WebFetch

**Tool name:** `WebFetch`

```typescript theme={null}
type WebFetchOutput = {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
  artifactRead?: {
    slug: string;
    ver?: string;
    seeded?: false;
  };
};
```

Returns the fetched content with HTTP status and metadata.

`artifactRead` is present only when Claude fetched an artifact the session can publish to, and it always carries that artifact's `slug`.

`seeded` is `false` on a read that didn't deliver the page's full source, and that entry carries no `ver`. The field requires Agent SDK v0.3.239 or later.

### WebSearch

**Tool name:** `WebSearch`

```typescript theme={null}
type WebSearchOutput = {
  query: string;
  results: Array<
    | {
        tool_use_id: string;
        content: Array<{ title: string; url: string }>;
      }
    | string
  >;
  durationSeconds: number;
  searchCount?: number;
};
```

Returns search results from the web.

### Workflow

**Tool name:** `Workflow`

```typescript theme={null}
type WorkflowOutput = {
  status: "async_launched" | "remote_launched";
  taskId: string;
  taskType?: "local_workflow" | "remote_agent";
  workflowName?: string;
  runId?: string;
  summary?: string;
  transcriptDir?: string;
  scriptPath?: string;
  sessionUrl?: string; // set when the workflow launched as a remote session
  warning?: string;
  error?: string;
};
```

Returns immediately after the tool accepts the invocation. The final result arrives later as a task completion. Check `error` before treating the run as started: a script that fails its syntax check returns `status: "async_launched"` with `error` set, and never runs.

| Field           | Type                                    | Description                                                                                                                                                         |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | `"async_launched" \| "remote_launched"` | The tool accepted the invocation. `"async_launched"` for in-process runs, `"remote_launched"` for runs dispatched to a remote session instead of running in-process |
| `taskId`        | `string`                                | Background task identifier for the run                                                                                                                              |
| `taskType`      | `"local_workflow" \| "remote_agent"`    | Task type of the registered background task, matching the `status` arm                                                                                              |
| `workflowName`  | `string`                                | The `meta.name` from the workflow script                                                                                                                            |
| `runId`         | `string`                                | Workflow run identifier to pass as `resumeFromRunId` on a later invocation. Absent for `remote_launched` runs, where the cloud session URL is the resume handle     |
| `summary`       | `string`                                | One-line description of what the workflow does                                                                                                                      |
| `transcriptDir` | `string`                                | Directory where subagent transcripts are written during execution                                                                                                   |
| `scriptPath`    | `string`                                | Path to the persisted workflow script for this run. Edit it and pass back as `scriptPath` to rerun without resending the script                                     |
| `sessionUrl`    | `string`                                | Cloud session URL, set when `status` is `"remote_launched"`                                                                                                         |
| `warning`       | `string`                                | Non-blocking heads-up, such as local git state diverging from the pushed branch a cloud session will clone                                                          |
| `error`         | `string`                                | Set when the script fails its syntax check. When present, the run did not start despite the launched status                                                         |

### TodoWrite

**Tool name:** `TodoWrite`

```typescript theme={null}
type TodoWriteOutput = {
  oldTodos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
  }>;
  newTodos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
  }>;
};
```

Returns the previous and updated task lists.

<Note>
  On TypeScript Agent SDK 0.3.233 and later, the following tools aren't available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, or later versions of those families unless you opt in:

  * `TodoWrite`
  * `TaskCreate`
  * `TaskGet`
  * `TaskUpdate`
  * `TaskList`

  On other models, Claude Code provides the Task tools by default and `TodoWrite` only when you set `CLAUDE_CODE_ENABLE_TASKS=0`.

  See [Model availability](/docs/en/agent-sdk/todo-tracking#model-availability) to opt in.
</Note>

### TaskCreate

**Tool name:** `TaskCreate`

```typescript theme={null}
type TaskCreateOutput = {
  task: {
    id: string;
    subject: string;
  };
};
```

Returns the created task with its assigned ID.

### TaskUpdate

**Tool name:** `TaskUpdate`

```typescript theme={null}
type TaskUpdateOutput = {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: {
    from: string;
    to: string;
  };
};
```

Returns the update result, including which fields changed.

### TaskGet

**Tool name:** `TaskGet`

```typescript theme={null}
type TaskGetOutput = {
  task: {
    id: string;
    subject: string;
    description: string;
    status: "pending" | "in_progress" | "completed";
    blocks: string[];
    blockedBy: string[];
  } | null;
};
```

Returns the full task record, or `null` when the ID is not found.

### TaskList

**Tool name:** `TaskList`

```typescript theme={null}
type TaskListOutput = {
  tasks: Array<{
    id: string;
    subject: string;
    status: "pending" | "in_progress" | "completed";
    owner?: string;
    blockedBy: string[];
  }>;
};
```

Returns a snapshot of all tasks in the current list.

### ExitPlanMode

**Tool name:** `ExitPlanMode`

```typescript theme={null}
type ExitPlanModeOutput = {
  plan: string | null;
  isAgent: boolean;
  filePath?: string;
  hasTaskTool?: boolean;
  planWasEdited?: boolean;
  awaitingLeaderApproval?: boolean;
  requestId?: string;
};
```

Returns the plan state after exiting plan mode.

### ListMcpResources

**Tool name:** `ListMcpResourcesTool`

```typescript theme={null}
type ListMcpResourcesOutput = Array<{
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  server: string;
}>;
```

Returns an array of available MCP resources.

### ReadMcpResource

**Tool name:** `ReadMcpResourceTool`

```typescript theme={null}
type ReadMcpResourceOutput = {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blobSavedTo?: string;
  }>;
  error?: string;
};
```

Returns the contents of the requested MCP resource.

### EnterWorktree

**Tool name:** `EnterWorktree`

```typescript theme={null}
type EnterWorktreeOutput = {
  worktreePath: string;
  worktreeBranch?: string;
  message: string;
};
```

Returns information about the git worktree.

### ExitWorktree

**Tool name:** `ExitWorktree`

```typescript theme={null}
type ExitWorktreeOutput = {
  action: "keep" | "remove";
  originalCwd: string;
  worktreePath: string;
  worktreeBranch?: string;
  tmuxSessionName?: string;
  discardedFiles?: number;
  discardedCommits?: number;
  message: string;
};
```

Returns the action taken and details about the worktree that was exited.

### EnterPlanMode

**Tool name:** `EnterPlanMode`

```typescript theme={null}
type EnterPlanModeOutput = {
  message: string;
};
```

Returns a confirmation that plan mode was entered.

### CronCreate

**Tool name:** `CronCreate`

```typescript theme={null}
type CronCreateOutput = {
  id: string;
  humanSchedule: string;
  recurring: boolean;
  durable?: boolean; // true when persisted to .claude/scheduled_tasks.json; false when session-only
};
```

Returns the job ID and a human-readable description of the schedule.

### CronDelete

**Tool name:** `CronDelete`

```typescript theme={null}
type CronDeleteOutput = {
  id: string;
};
```

Returns the ID of the deleted job.

### CronList

**Tool name:** `CronList`

```typescript theme={null}
type CronListOutput = {
  jobs: {
    id: string;
    cron: string;
    humanSchedule: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
  }[];
};
```

Returns the scheduled cron jobs: durable jobs from `.claude/scheduled_tasks.json` and session-only jobs from the current session. A session-only job carries `durable: false`; jobs read from disk omit the field.

### ScheduleWakeup

**Tool name:** `ScheduleWakeup`

```typescript theme={null}
type ScheduleWakeupOutput = {
  scheduledFor: number;
  clampedDelaySeconds: number;
  wasClamped: boolean;
  stopped?: boolean;
  cancelledWakeups?: number;
};
```

Returns when the wake-up will fire as an epoch millisecond timestamp, the delay actually used, and whether the requested delay was clamped. The `stopped` field is `true` when the call ended the loop with `stop: true`. It requires Claude Code v2.1.202 or later. The `cancelledWakeups` field counts how many pending wakeups a `stop: true` call cancelled. A value of 0 means nothing was pending, and a recurring `/loop` cron isn't cancelled by `stop: true`. It requires Claude Code v2.1.206 or later.

### RemoteTrigger

**Tool name:** `RemoteTrigger`

```typescript theme={null}
type RemoteTriggerOutput = {
  status: number;
  json: string;
  summary?: string;
};
```

Returns the API response status and body for the trigger operation.

### PushNotification

**Tool name:** `PushNotification`

```typescript theme={null}
type PushNotificationOutput = {
  message: string;
  pushSent?: boolean;
  localSent?: boolean;
  disabledReason?: "config_off" | "user_present" | "no_transport";
  sentAt?: string;
};
```

Returns delivery details, including whether a push or local notification was sent and why delivery was skipped.

### REPL

**Tool name:** `REPL`

```typescript theme={null}
type REPLOutput = {
  code: string;
  result: {
    [k: string]: unknown;
  };
  stdout: string;
  stderr: string;
  error?: string;
  registeredTools?: string[];
  images?: {
    base64: string;
    mediaType: string;
  }[];
  documents?: {
    base64: string;
  }[];
};
```

Returns the execution result, captured console output, and any images or documents surfaced by inner `Read` calls.

### ReportFindings

**Tool name:** `ReportFindings`

```typescript theme={null}
type ReportFindingsOutput = {
  count: number;
  level?: "low" | "medium" | "high" | "xhigh" | "max";
  findings: Array<{
    file: string;
    line?: number;
    summary: string;
    failure_scenario: string;
    short_summary?: string;
    category?: string;
    verdict?: "CONFIRMED" | "PLAUSIBLE";
    outcome?: "fixed" | "skipped" | "no_change_needed";
  }>;
};
```

Returns the number of findings reported, the effort level the review ran at, and the findings echoed back for the result body. Requires Claude Code v2.1.196 or later. The echoed `short_summary` field requires Claude Code v2.1.212 or later.

### Artifact

**Tool name:** `Artifact`

```typescript theme={null}
type ArtifactOutput =
  | {
      url: string;
      path: string;
      title?: string;
      version?: string;
      capabilities?: unknown;
      stored?: {
        contract: string;
        capabilities?: Record<string, unknown>;
      };
      warnings?: string[];
      contract?: string;
      updated?: boolean;
      liveSubscription?: string;
    }
  | {
      artifacts: Array<{
        title: string;
        url: string;
        updatedAt?: string;
        rel?: "mine" | "shared";
      }>;
      truncated?: boolean;
      scope?: "shared" | "all";
    };
```

Returns the published page's `url` and the local `path` that was published for the publish action, with `updated` set to true when the publish redeployed an existing artifact, and `warnings` carrying any publish-time advisories. The list action returns the `artifacts` rows instead, with `truncated` set when more artifacts exist than the requested limit. On listings whose scope isn't `"mine"`, each row carries `rel` marking whether the user owns the artifact or it was shared with them, and the output's `scope` records which non-default scope produced the listing; both are absent on default listings.

### Projects

**Tool name:** `Projects`

```typescript theme={null}
type ProjectsOutput =
  | {
      method: "project_info";
      notice?: string;
      name: string;
      description: string;
      instructions: string;
      docs: Array<{ path: string; created_at: string | null }>;
      files?: Array<{
        path: string;
        file_kind: string;
        created_at: string | null;
      }>;
      sync_sources?: Array<{
        type: string | null;
        config: Record<string, unknown>;
      }>;
      knowledge: {
        knowledge_size: number;
        max_knowledge_size: number;
      };
    }
  | {
      method: "project_read";
      notice?: string;
      path: string;
      file_kind?: string;
      content?: string;
      local_file?: string;
      created_at: string | null;
    }
  | {
      method: "project_search";
      notice?: string;
      rag: boolean;
      hits?: Array<{ name?: string; doc_uuid?: string; text?: string }>;
      docs?: string[];
    }
  | {
      method: "project_write";
      notice?: string;
      path: string;
      doc_uuid: string;
      replaced: boolean;
      present_to_user?: boolean;
      local_path?: string;
    }
  | {
      method: "project_delete";
      notice?: string;
      path: string;
      deleted: boolean;
    };
```

Discriminated on the `method` field, mirroring the input. `project_read` returns small text docs inline in `content` and writes larger docs to a `local_file` path instead; `project_search` returns RAG `hits` with `rag: true` when the project's index is available and falls back to a `docs` path list otherwise.

### ReadMcpResourceDir

**Tool name:** `ReadMcpResourceDirTool`

```typescript theme={null}
type ReadMcpResourceDirOutput = {
  resources: Array<{
    uri: string;
    name: string;
    mimeType?: string;
  }>;
  error?: string;
};
```

Returns the direct children of the directory resource. Subdirectories appear with mimeType `"inode/directory"`; `error` carries a human-readable message when the server couldn't list the directory.

### RefreshMcpTools

**Tool name:** `RefreshMcpTools`

```typescript theme={null}
type RefreshMcpToolsOutput = Array<{
  server: string;
  status: "refreshed" | "error" | "not_connected";
  toolCount?: number; // tools now available from this server
  added?: string[]; // tool names this refresh added
  removed?: string[]; // tool names this refresh removed
  error?: string; // why the refresh failed or the server was unavailable
}>;
```

Returns one entry per server: `refreshed` means the re-queried tool list was applied, `error` means the re-query failed and the previous tool set was kept, and `not_connected` means the server has no live connection to query.

### ShowOnboardingRolePicker

**Tool name:** `ShowOnboardingRolePicker`

```typescript theme={null}
type ShowOnboardingRolePickerOutput = {
  role?: string;
  dismissed?: boolean;
};
```

Returns the user's selection: `role` when they picked a role chip or typed one, and `dismissed: true` when they closed the picker. An empty object means the user approved the call without picking a role.

### McpOutput

**Tool name:** dynamic MCP tool names of the form `mcp__<server>__<tool>`

```typescript theme={null}
type McpOutput =
  | string
  | {
      type: string;
      [k: string]: unknown;
    }[]
  | {
      [k: string]: unknown;
    };
```

MCP tool results are returned as a string or an array of content blocks, depending on the server. The trailing plain-object branch in the exported type is a schema-generation artifact: the SDK doesn't return a bare object, because a server's structured output is serialized to a JSON string before being returned. At runtime the value may also be `undefined`, although the exported type doesn't model this.

## Permission Types

### `PermissionUpdate`

Operations for updating permissions.

```typescript theme={null}
type PermissionUpdate =
  | {
      type: "addRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "replaceRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "addDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    };
```

### `PermissionBehavior`

```typescript theme={null}
type PermissionBehavior = "allow" | "deny" | "ask";
```

### `PermissionUpdateDestination`

```typescript theme={null}
type PermissionUpdateDestination =
  | "userSettings" // Global user settings
  | "projectSettings" // Per-directory project settings
  | "localSettings" // Local project settings
  | "session" // Current session only
  | "cliArg"; // CLI argument
```

### `PermissionRuleValue`

```typescript theme={null}
type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};
```

## Other Types

### `ApiKeySource`

Where the API key for the session's requests came from, reported as `apiKeySource` on the [`SDKSystemMessage`](#sdksystemmessage) init message.

```typescript theme={null}
type ApiKeySource =
  | "ANTHROPIC_API_KEY"
  | "apiKeyHelper"
  | "/login managed key"
  | "none"
  | "user"
  | "project"
  | "org"
  | "temporary"
  | "oauth";
```

Claude Code reports one of four values:

| Value                | Key in use                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | The key in the `ANTHROPIC_API_KEY` environment variable                                                                         |
| `apiKeyHelper`       | The key returned by your [`apiKeyHelper`](/docs/en/settings-reference#apikeyhelper) command                                          |
| `/login managed key` | The key Claude Code stored when you logged in with a [Claude Console account](/docs/en/authentication#claude-console-authentication) |
| `none`               | No API key. The session authenticates another way, such as a claude.ai login, a bearer token, or a cloud provider               |

Agent SDK v0.3.234 and later list these four values in the type. The type also keeps `user`, `project`, `org`, `temporary`, and `oauth` so older code still compiles, and Claude Code doesn't report them.

### `SdkBeta`

Available beta features that can be enabled via the `betas` option. See [Beta headers](https://platform.claude.com/docs/en/api/beta-headers) for more information.

```typescript theme={null}
type SdkBeta = "context-1m-2025-08-07";
```

<Warning>
  The `context-1m-2025-08-07` beta is retired as of April 30, 2026. Passing this value with Claude Sonnet 4.5 or Sonnet 4 has no effect, and requests that exceed the standard 200k-token context window return an error. To use a 1M-token context window, migrate to [Claude Opus 5, Claude Sonnet 5, Claude Sonnet 4.6, Claude Opus 4.6, Claude Opus 4.7, or Claude Opus 4.8](https://platform.claude.com/docs/en/about-claude/models/overview), which include 1M context at standard pricing with no beta header required.
</Warning>

### `SlashCommand`

Information about an available slash command.

```typescript theme={null}
type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
};
```

### `ModelInfo`

Information about an available model.

```typescript theme={null}
type ModelInfo = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ("low" | "medium" | "high" | "xhigh" | "max")[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};
```

| Field                      | Type                                                               | Description                                                                                                                                                                                                                                                                               |
| :------------------------- | :----------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`                    | `string`                                                           | Model identifier to pass in API calls                                                                                                                                                                                                                                                     |
| `resolvedModel`            | `string \| undefined`                                              | Canonical wire model ID that this entry's `value` resolves to. An alias entry such as `sonnet` resolves to an explicit model ID such as `claude-sonnet-5`, so a host can match a stored explicit model ID against the alias entry that covers it. Requires Claude Code v2.1.197 or later. |
| `displayName`              | `string`                                                           | Human-readable display name                                                                                                                                                                                                                                                               |
| `description`              | `string`                                                           | Description of the model's capabilities                                                                                                                                                                                                                                                   |
| `supportsEffort`           | `boolean \| undefined`                                             | Whether this model supports effort levels                                                                                                                                                                                                                                                 |
| `supportedEffortLevels`    | `("low" \| "medium" \| "high" \| "xhigh" \| "max")[] \| undefined` | Effort levels this model accepts                                                                                                                                                                                                                                                          |
| `supportsAdaptiveThinking` | `boolean \| undefined`                                             | Whether this model supports adaptive thinking, where Claude decides when and how much to think                                                                                                                                                                                            |
| `supportsFastMode`         | `boolean \| undefined`                                             | Whether this model supports fast mode                                                                                                                                                                                                                                                     |
| `supportsAutoMode`         | `boolean \| undefined`                                             | Whether this model supports auto mode                                                                                                                                                                                                                                                     |

### `AgentInfo`

Information about an available subagent that can be invoked via the Agent tool.

```typescript theme={null}
type AgentInfo = {
  name: string;
  description: string;
  model?: string;
};
```

| Field         | Type                  | Description                                                          |
| :------------ | :-------------------- | :------------------------------------------------------------------- |
| `name`        | `string`              | Agent type identifier (e.g., `"Explore"`, `"general-purpose"`)       |
| `description` | `string`              | Description of when to use this agent                                |
| `model`       | `string \| undefined` | Model alias this agent uses. If omitted, inherits the parent's model |

### `McpServerStatus`

Status of a connected MCP server.

```typescript theme={null}
type McpServerStatus = {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
  config?: McpServerStatusConfig;
  scope?: string;
  tools?: {
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }[];
};
```

### `McpServerStatusConfig`

The configuration of an MCP server as reported by `mcpServerStatus()`. This is the union of all MCP server transport types.

```typescript theme={null}
type McpServerStatusConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig
  | McpClaudeAIProxyServerConfig;
```

See [`McpServerConfig`](#mcpserverconfig) for details on each transport type.

### `AccountInfo`

Account information for the authenticated user.

```typescript theme={null}
type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
};
```

### `ModelUsage`

Per-model usage statistics returned in result messages. The `costUSD` value is a client-side estimate. See [Track cost and usage](/docs/en/agent-sdk/cost-tracking) for billing caveats.

```typescript theme={null}
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
  canonicalModel?: string;
  provider?: string;
};
```

The `canonicalModel` and `provider` fields require Claude Code v2.1.218 or later. `canonicalModel` is the canonical model ID that the pricing lookup uses; it can differ from the raw model string that keys the entry, for example when that string is a provider-specific ID or an alias.

`provider` names the API backend that served the model, such as `firstParty`, `bedrock`, `vertex`, `foundry`, `anthropicAws`, `mantle`, or `gateway`.

### `ConfigScope`

```typescript theme={null}
type ConfigScope = "local" | "user" | "project";
```

### `NonNullableUsage`

A version of [`Usage`](#usage) with all nullable fields made non-nullable.

```typescript theme={null}
type NonNullableUsage = {
  [K in keyof Usage]: NonNullable<Usage[K]>;
};
```

### `Usage`

Token usage statistics. This is the `BetaUsage` type from `@anthropic-ai/sdk`.

```typescript theme={null}
type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  } | null;
  server_tool_use: BetaServerToolUsage | null;
  service_tier: "standard" | "priority" | "batch" | null;
  speed: "standard" | "fast" | null;
  inference_geo: string | null;
  iterations: BetaIterationsUsage | null;
};
```

`BetaServerToolUsage` and `BetaIterationsUsage` are defined in `@anthropic-ai/sdk`.

### `CallToolResult`

MCP tool result type (from `@modelcontextprotocol/sdk/types.js`). `structuredContent` is a JSON object that can be returned alongside `content`, including image blocks. See [Return structured data](/docs/en/agent-sdk/custom-tools#return-structured-data).

```typescript theme={null}
type CallToolResult = {
  content: Array<{
    type: "text" | "image" | "audio" | "resource" | "resource_link";
    // Additional fields vary by type
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
```

### `ThinkingConfig`

Controls Claude's thinking/reasoning behavior. Takes precedence over the deprecated `maxThinkingTokens`.

```typescript theme={null}
type ThinkingDisplay = "summarized" | "omitted";

type ThinkingConfig =
  | { type: "adaptive"; display?: ThinkingDisplay } // The model determines when and how much to reason (Opus 4.6+)
  | { type: "enabled"; budgetTokens?: number; display?: ThinkingDisplay } // Fixed thinking token budget
  | { type: "disabled" }; // No extended thinking
```

The optional `display` field controls whether thinking text is returned `"summarized"` or `"omitted"`. On Claude Opus 4.7 and later, the API default is `"omitted"`, so set `"summarized"` to receive thinking content in `thinking` blocks. Claude Code doesn't send `display` to Amazon Bedrock or Google Cloud's Agent Platform, so on those providers Opus 4.7 and later return empty `thinking` blocks even when you set `display` to `"summarized"`.

### `SpawnedProcess`

Interface for custom process spawning (used with `spawnClaudeCodeProcess` option). `ChildProcess` already satisfies this interface.

```typescript theme={null}
interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void;
  off(event: "error", listener: (error: Error) => void): void;
}
```

### `SpawnOptions`

Options passed to the custom spawn function.

```typescript theme={null}
interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}
```

<Note>
  The `signal` field tells your spawn function when to tear down the process. Pass it as the `signal` option to Node's `spawn()`, or pass it to your VM or container teardown handler.

  This signal does not fire the instant [`Options.abortController`](#options) aborts. The SDK first closes the process's stdin and waits about two seconds so the CLI can shut down cleanly, then aborts this signal. To react the moment the caller aborts instead, listen on your own `Options.abortController.signal`, which your spawn function can reference from its enclosing scope.
</Note>

### `McpSetServersResult`

Result of a `setMcpServers()` operation.

```typescript theme={null}
type McpSetServersResult = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
};
```

### `RewindFilesResult`

Result of a `rewindFiles()` operation.

```typescript theme={null}
type RewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
};
```

`skippedLinks` counts the tracked paths the rewind refused to restore or delete for link safety: a symlink, hard link, or other non-regular file at the tracked path, a parent directory that no longer resolves to where it pointed when the checkpoint was taken, or a backup that couldn't be read safely. The field requires Claude Code v2.1.216 or later. A preview call with `rewindFiles(userMessageId, { dryRun: true })` never sets it.

### `SDKStatusMessage`

Status update message (e.g., compacting).

```typescript theme={null}
type SDKStatusMessage = {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: PermissionMode;
  uuid: UUID;
  session_id: string;
};
```

### `SDKTaskNotificationMessage`

Notification when a background task completes, fails, or is stopped. Background tasks include `run_in_background` Bash commands, [Monitor](#monitor) watches, and background subagents.

```typescript theme={null}
type SDKTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  uuid: UUID;
  session_id: string;
};
```

Claude Code prepends a notice to every task notification it sends to the model, except deliveries stamped with the [`scheduled-trigger` subkind](#task-notification-subkinds), which carry an assigned-task framing instead. The notice states that no human input has occurred, so the model doesn't treat the notification as a user instruction or approval.

To detect a task-notification turn, check `origin.kind === "task-notification"` on the [`SDKUserMessage`](#sdkusermessage) or [`SDKResultMessage`](#sdkresultmessage) rather than matching on the notice text. Read `subkind` from the same field if you need to know what raised it. Before v2.1.205, Claude Code left the notice off notifications that arrived while the session was idle.

### `SDKToolUseSummaryMessage`

Summary of tool usage in a conversation.

```typescript theme={null}
type SDKToolUseSummaryMessage = {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: UUID;
  session_id: string;
};
```

### `SDKHookStartedMessage`

Emitted when a hook begins executing.

Claude Code delivers this message, [`SDKHookProgressMessage`](#sdkhookprogressmessage), and [`SDKHookResponseMessage`](#sdkhookresponsemessage) to the message stream immediately, including while a `SessionStart` or `Setup` hook is still running during session startup. Claude Code v2.1.169 through v2.1.203 delivered these messages in one batch after a `SessionStart` or `Setup` hook completed; v2.1.204 restored live delivery.

```typescript theme={null}
type SDKHookStartedMessage = {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKHookProgressMessage`

Emitted while a hook is running, with stdout/stderr output.

```typescript theme={null}
type SDKHookProgressMessage = {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKHookResponseMessage`

Emitted when a hook finishes executing.

```typescript theme={null}
type SDKHookResponseMessage = {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  uuid: UUID;
  session_id: string;
};
```

### `SDKToolProgressMessage`

Emitted periodically while a tool is executing to indicate progress.

```typescript theme={null}
type SDKToolProgressMessage = {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
  heartbeat?: boolean;
  subagent_type?: string;
  subagent_retry?: {
    agent_id: string;
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error_category: string;
  };
  uuid: UUID;
  session_id: string;
};
```

While a tool call runs in the main conversation, Claude Code emits a `tool_progress` message every 30 seconds with `heartbeat: true`. Each heartbeat carries the tool name and elapsed seconds, so you can distinguish a long-running call from a stalled session. Claude Code doesn't emit heartbeats for the Agent tool, whose subagents stream their own progress, or for tool calls inside a subagent. The `heartbeat` field requires Agent SDK v0.3.214 or later.

On `tool_progress` messages for the Agent tool, `subagent_type` names the running subagent type, such as `general-purpose`. `subagent_retry` is present while that subagent waits out an API error backoff, such as a rate limit or overload, with one message per retry attempt. Both fields require Agent SDK v0.3.214 or later.

To render a retry indicator from `subagent_retry`:

* Track the indicator by `parent_tool_use_id`, which is unique per subagent. `tool_use_id` is shared by parallel subagents from one assistant turn, so tracking by it would let one subagent's update clear another's indicator.
* Clear the indicator when a later `tool_progress` for the same `parent_tool_use_id` arrives without the field, or when the tool's result message arrives. `attempt` can exceed `max_retries` under persistent retry, so don't derive clearing from the counters.
* Treat `error_category` as a closed set of tokens for choosing your own message text, not as display text: `rate_limit`, `overloaded`, `authentication_failed`, `server_error`, or `unknown`.

### `SDKAuthStatusMessage`

Emitted during authentication flows.

```typescript theme={null}
type SDKAuthStatusMessage = {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKTaskStartedMessage`

Emitted when a task begins. The `task_type` field is `"local_bash"` for Bash commands and [Monitor](#monitor) watches, `"local_agent"` for subagents, or `"remote_agent"`.

```typescript theme={null}
type SDKTaskStartedMessage = {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  is_backgrounded?: boolean;
  spawn_depth?: number;
  uuid: UUID;
  session_id: string;
};
```

`is_backgrounded` and `spawn_depth` describe how Claude Code started the task. Both fields require Agent SDK v0.3.238 or later.

* `is_backgrounded`: Claude Code sets it on `"local_agent"` and `"local_bash"` tasks. `true` means the task runs in the background. `false` means the task runs in the foreground, and the tool call that started it stays blocked until the task finishes or moves to the background.
* `spawn_depth`: Claude Code sets it on `"local_agent"` tasks only. A subagent that the main thread spawned has depth `1`. A subagent that a depth `1` subagent spawned has depth `2`, and so on.

A [resumed subagent](/docs/en/agent-sdk/subagents#resume-subagents) always reports `is_backgrounded: true`, because Claude Code runs every resumed subagent in the background. When a foreground task moves to the background later, Claude Code reports the new `is_backgrounded` value in a [`task_updated`](#sdktaskupdatedmessage) message rather than sending a second `task_started`.

### `SDKTaskProgressMessage`

Emitted periodically while a subagent or background task is running. The `summary` field is populated only when [`agentProgressSummaries`](#options) is enabled.

```typescript theme={null}
type SDKTaskProgressMessage = {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  summary?: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKTaskUpdatedMessage`

Emitted when a background task's state changes, such as when it transitions from `running` to `completed`. Merge `patch` into your local task map keyed by `task_id`. The `end_time` field is a Unix epoch timestamp in milliseconds, comparable with `Date.now()`.

```typescript theme={null}
type SDKTaskUpdatedMessage = {
  type: "system";
  subtype: "task_updated";
  task_id: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed";
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  uuid: UUID;
  session_id: string;
};
```

### `SDKBackgroundTasksChangedMessage`

Emitted whenever the set of live background tasks changes: a task starts, completes, is killed, or a foreground agent is backgrounded. The `tasks` array is the full live set. Replace any cached set with each payload instead of pairing `task_started` and `task_notification` events, so the next membership change corrects any event you missed.

Ordering relative to those per-task events is unspecified, so don't correlate the two streams.

Nothing is emitted at startup. Reset to an empty set whenever the session's CLI process starts or restarts and let the next membership change repopulate it.

When you send a repeated `initialize` control request to a running session, such as with [`reinitialize()`](#query-object) after a transport gap, Claude Code follows the response with a snapshot of the current live set, even when it is empty. A reconnecting host therefore learns what is running without waiting for the next membership change. Before Agent SDK v0.3.239, Claude Code sent no snapshot after a repeated `initialize`.

Requires Claude Code v2.1.203 or later.

```typescript theme={null}
type SDKBackgroundTasksChangedMessage = {
  type: "system";
  subtype: "background_tasks_changed";
  tasks: {
    task_id: string;
    task_type: string;
    description: string;
  }[];
  uuid: UUID;
  session_id: string;
};
```

### `SDKThinkingTokensMessage`

Emitted while Claude is producing a thinking block, including a redacted one, carrying a running estimate of the thinking tokens generated so far. `estimated_tokens` is the running total for the current thinking block and `estimated_tokens_delta` is the increment carried by this frame. Use it for progress display. The final count for the top-level agent loop is the result message's `usage.output_tokens`, which [doesn't include subagent tokens](/docs/en/agent-sdk/cost-tracking#get-the-total-cost-of-a-query); use [`modelUsage`](#modelusage) for whole-tree accounting.

Requires Claude Code v2.1.153 or later.

```typescript theme={null}
type SDKThinkingTokensMessage = {
  type: "system";
  subtype: "thinking_tokens";
  estimated_tokens: number;
  estimated_tokens_delta: number;
  uuid: UUID;
  session_id: string;
};
```

### `SDKFilesPersistedEvent`

Emitted when file checkpoints are persisted to disk.

```typescript theme={null}
type SDKFilesPersistedEvent = {
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKRateLimitEvent`

Emitted when the session encounters a rate limit.

```typescript theme={null}
type SDKRateLimitEvent = {
  type: "rate_limit_event";
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    utilization?: number;
    errorCode?: "credits_required";
    canUserPurchaseCredits?: boolean;
    hasChargeableSavedPaymentMethod?: boolean;
  };
  uuid: UUID;
  session_id: string;
};
```

When `errorCode` is `"credits_required"`, the rejection is from a claude.ai subscription whose included usage is exhausted, and the session cannot continue until the user buys usage credits. `canUserPurchaseCredits` indicates whether the authenticated user can buy credits for the account, and `hasChargeableSavedPaymentMethod` indicates whether a saved payment method is on file. All three fields are absent on rate-limit events that are not credits-required rejections. Requires Claude Code v2.1.181 or later.

### `SDKLocalCommandOutputMessage`

Output from a local command such as `/voice` or `/usage`. Displayed as assistant-style text in the transcript.

```typescript theme={null}
type SDKLocalCommandOutputMessage = {
  type: "system";
  subtype: "local_command_output";
  content: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKCommandsChangedMessage`

Emitted when the set of available commands changes mid-session, such as when Claude Code discovers skills as the agent enters a subdirectory. The `commands` array is the full updated list, so replace any cached command list with this payload. Calling [`supportedCommands()`](#query-object) after this message returns the same updated list, because the method tracks the latest push; this requires Agent SDK v0.3.216 or later. In earlier SDK versions, `supportedCommands()` returns the snapshot captured at initialization and never reflects mid-session changes.

```typescript theme={null}
type SDKCommandsChangedMessage = {
  type: "system";
  subtype: "commands_changed";
  commands: SlashCommand[];
  uuid: UUID;
  session_id: string;
};
```

### `SDKPromptSuggestionMessage`

Emitted after a turn when [`promptSuggestions`](#options) is enabled and Claude Code generated a suggestion for that turn. Contains the predicted next user prompt. For the turns that get none, see [When Claude Code skips suggestions](/docs/en/interactive-mode#when-claude-code-skips-suggestions).

```typescript theme={null}
type SDKPromptSuggestionMessage = {
  type: "prompt_suggestion";
  suggestion: string;
  uuid: UUID;
  session_id: string;
};
```

### `SDKConversationResetMessage`

Emitted when the session's conversation is replaced without ending the session. In a `query()` call, only `/clear` and its aliases produce this message. Mount an empty transcript under `new_conversation_id` and discard any cached session title.

```typescript theme={null}
type SDKConversationResetMessage = {
  type: "conversation_reset";
  new_conversation_id: UUID;
  uuid: UUID;
  session_id: string;
};
```

The SDK's published typings declare `SDKConversationResetMessage` in Claude Code v2.1.203 and later. Before v2.1.203, `SDKMessage` referenced the type without declaring it, so narrowing on `type === "conversation_reset"` failed to typecheck when `skipLibCheck` was disabled.

### `AbortError`

Custom error class for abort operations.

```typescript theme={null}
class AbortError extends Error {}
```

## Sandbox Configuration

### `SandboxSettings`

Configuration for sandbox behavior. Use this to enable command sandboxing and configure network restrictions programmatically.

```typescript theme={null}
type SandboxSettings = {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: SandboxNetworkConfig;
  filesystem?: SandboxFilesystemConfig;
  ignoreViolations?: Record<string, string[]>;
  enableWeakerNestedSandbox?: boolean;
  ripgrep?: { command: string; args?: string[] };
};
```

| Property                    | Type                                                  | Default     | Description                                                                                                                                                                                                                             |
| :-------------------------- | :---------------------------------------------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `boolean`                                             | `false`     | Enable sandbox mode for command execution                                                                                                                                                                                               |
| `failIfUnavailable`         | `boolean`                                             | `true`      | Stop at startup if `enabled` is `true` but the sandbox can't start. Set `false` to fall back to unsandboxed execution with a warning on stderr                                                                                          |
| `autoAllowBashIfSandboxed`  | `boolean`                                             | `true`      | Auto-approve bash commands when sandbox is enabled                                                                                                                                                                                      |
| `excludedCommands`          | `string[]`                                            | `[]`        | Commands that always bypass sandbox restrictions (e.g., `['docker']`). These run unsandboxed automatically without model involvement                                                                                                    |
| `allowUnsandboxedCommands`  | `boolean`                                             | `true`      | Allow the model to request running commands outside the sandbox. When `true`, the model can set `dangerouslyDisableSandbox` in tool input, which falls back to the [permissions system](#permissions-fallback-for-unsandboxed-commands) |
| `network`                   | [`SandboxNetworkConfig`](#sandboxnetworkconfig)       | `undefined` | Network-specific sandbox configuration                                                                                                                                                                                                  |
| `filesystem`                | [`SandboxFilesystemConfig`](#sandboxfilesystemconfig) | `undefined` | Filesystem-specific sandbox configuration for read/write restrictions                                                                                                                                                                   |
| `ignoreViolations`          | `Record<string, string[]>`                            | `undefined` | Map of command substrings, or `*` for every command, to substrings of the violation text to ignore, such as `{ "*": ['/etc/hosts'] }`; see [`sandbox.ignoreViolations`](/docs/en/settings-reference#sandbox-ignoreviolations)                |
| `enableWeakerNestedSandbox` | `boolean`                                             | `false`     | Enable a weaker nested sandbox for compatibility                                                                                                                                                                                        |
| `ripgrep`                   | `{ command: string; args?: string[] }`                | `undefined` | Custom ripgrep binary configuration for sandbox environments                                                                                                                                                                            |

<Note>
  The sandbox depends on platform support and, on Linux, tools like `bubblewrap` and `socat`. When `enabled` is `true` and the sandbox can't start, `query()` reports a `result` message with `subtype: "error_during_execution"` and the reason in `errors`. For a single message `query()` call, the SDK throws after yielding that error result, so wrap the loop in a try block to continue past it. See [Handle the result](/docs/en/agent-sdk/agent-loop#handle-the-result) for the error contract.

  To run unsandboxed instead, set `failIfUnavailable: false`.
</Note>

#### Example usage

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

try {
  for await (const message of query({
    prompt: "Build and test my project",
    options: {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: {
          allowLocalBinding: true
        }
      }
    }
  })) {
    if ("result" in message) console.log(message.result);
  }
} catch (error) {
  // A single-shot query() throws after yielding an error result,
  // such as when the sandbox can't start (failIfUnavailable defaults to true).
  console.log(`Session ended with an error: ${error}`);
}
```

<Warning>
  **Unix socket security:** The `allowUnixSockets` option can grant access to powerful system services. For example, allowing `/var/run/docker.sock` effectively grants full host system access through the Docker API, bypassing sandbox isolation. Only allow Unix sockets that are strictly necessary and understand the security implications of each.
</Warning>

### `SandboxNetworkConfig`

Network-specific configuration for sandbox mode. These settings apply to sandboxed Bash commands when `enabled` is `true` in the parent [`SandboxSettings`](#sandboxsettings). They do not restrict the WebFetch tool, which uses [permission rules](/docs/en/permissions#webfetch) instead.

```typescript theme={null}
type SandboxNetworkConfig = {
  allowedDomains?: string[];
  deniedDomains?: string[];
  strictAllowlist?: boolean;
  allowManagedDomainsOnly?: boolean;
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
};
```

| Property                  | Type       | Default     | Description                                                                                                                                                                                                                                                                                                                                                     |
| :------------------------ | :--------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedDomains`          | `string[]` | `[]`        | Domain names that sandboxed processes can access                                                                                                                                                                                                                                                                                                                |
| `deniedDomains`           | `string[]` | `[]`        | Domain names that sandboxed processes cannot access. Takes precedence over `allowedDomains`                                                                                                                                                                                                                                                                     |
| `strictAllowlist`         | `boolean`  | `false`     | Deny sandboxed commands access to hosts outside the [network allowlist](/docs/en/sandboxing#network-isolation) instead of prompting. Enforced for sandboxed commands only; in-process tools such as WebFetch aren't gated by it. Only honored from user, managed, or CLI `--settings` settings; project settings are ignored. Requires Claude Code v2.1.219 or later |
| `allowManagedDomainsOnly` | `boolean`  | `false`     | Managed-settings only. When set in [managed settings](/docs/en/managed-settings), only `allowedDomains` entries and `WebFetch(domain:...)` allow rules from managed settings are honored, and allow entries from user, project, or local settings are ignored. Has no effect when set via SDK options                                                                |
| `allowLocalBinding`       | `boolean`  | `false`     | Allow processes to bind to local ports (e.g., for dev servers)                                                                                                                                                                                                                                                                                                  |
| `allowUnixSockets`        | `string[]` | `[]`        | Unix socket paths that processes can access (e.g., Docker socket)                                                                                                                                                                                                                                                                                               |
| `allowAllUnixSockets`     | `boolean`  | `false`     | Allow access to all Unix sockets                                                                                                                                                                                                                                                                                                                                |
| `httpProxyPort`           | `number`   | `undefined` | HTTP proxy port for network requests                                                                                                                                                                                                                                                                                                                            |
| `socksProxyPort`          | `number`   | `undefined` | SOCKS proxy port for network requests                                                                                                                                                                                                                                                                                                                           |

<Note>
  The built-in sandbox proxy enforces `allowedDomains` based on the requested hostname and does not terminate or inspect TLS traffic, so techniques such as [domain fronting](https://en.wikipedia.org/wiki/Domain_fronting) can potentially bypass it. See [Sandboxing security limitations](/docs/en/sandboxing#security-limitations) for details and [Secure deployment](/docs/en/agent-sdk/secure-deployment#traffic-forwarding) for configuring a TLS-terminating proxy.
</Note>

### `SandboxFilesystemConfig`

Filesystem-specific configuration for sandbox mode.

```typescript theme={null}
type SandboxFilesystemConfig = {
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
};
```

| Property     | Type       | Default | Description                                 |
| :----------- | :--------- | :------ | :------------------------------------------ |
| `allowWrite` | `string[]` | `[]`    | File path patterns to allow write access to |
| `denyWrite`  | `string[]` | `[]`    | File path patterns to deny write access to  |
| `denyRead`   | `string[]` | `[]`    | File path patterns to deny read access to   |

### Permissions Fallback for Unsandboxed Commands

When `allowUnsandboxedCommands` is enabled, the model can request to run commands outside the sandbox by setting `dangerouslyDisableSandbox: true` in the tool input. These requests fall back to the existing permissions system, meaning your `canUseTool` handler is invoked, allowing you to implement custom authorization logic. In the example below, `isCommandAuthorized` stands in for an authorization check you define.

<Note>
  **`excludedCommands` vs `allowUnsandboxedCommands`:**

  * `excludedCommands`: A static list of commands that always bypass the sandbox automatically (e.g., `['docker']`). The model has no control over this.
  * `allowUnsandboxedCommands`: Lets the model decide at runtime whether to request unsandboxed execution by setting `dangerouslyDisableSandbox: true` in the tool input.
</Note>

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Deploy my application",
  options: {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: true // Model can request unsandboxed execution
    },
    permissionMode: "default",
    canUseTool: async (tool, input) => {
      // Check if the model is requesting to bypass the sandbox
      if (tool === "Bash" && input.dangerouslyDisableSandbox) {
        // The model is requesting to run this command outside the sandbox
        console.log(`Unsandboxed command requested: ${input.command}`);

        if (isCommandAuthorized(input.command)) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return {
          behavior: "deny" as const,
          message: "Command not authorized for unsandboxed execution"
        };
      }
      return { behavior: "allow" as const, updatedInput: input };
    }
  }
})) {
  if ("result" in message) console.log(message.result);
}
```

<Warning>
  Commands running with `dangerouslyDisableSandbox: true` have full system access. Ensure your `canUseTool` handler validates these requests carefully.

  If `permissionMode` is set to `bypassPermissions` and `allowUnsandboxedCommands` is enabled, the model can autonomously execute commands outside the sandbox without approval prompts, apart from the [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves). This combination effectively allows the model to escape sandbox isolation silently.
</Warning>

## See also

* [SDK overview](/docs/en/agent-sdk/overview) - General SDK concepts
* [Python SDK reference](/docs/en/agent-sdk/python) - Python SDK documentation
* [CLI reference](/docs/en/cli-reference) - Command-line interface
* [Common workflows](/docs/en/common-workflows) - Step-by-step guides
