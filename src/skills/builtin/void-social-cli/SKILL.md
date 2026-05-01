---
name: void-social-cli
description: Reference documentation for the void social CLI tools. Use when working with Bluesky/X notifications, timeline feeds, horizon radar monitoring, thread archiving, posting, dispatching, or blocking via the void social CLI.
---

# Void Social CLI

Reference documentation for the `void` social CLI — a command-line interface for Bluesky and X notification sync, timeline consumption, horizon monitoring, thread archiving, posting, dispatch, and blocking.

## Commands

### `sync`

Syncs notifications from Bluesky and/or X into local inbox files.

```bash
void sync
void sync --source bsky
void sync --source x
```

| Flag | Description |
|------|-------------|
| `--source <platform>` | Limit sync to `bsky` or `x`. Omit to sync all. |

Writes incoming notifications to `inbox-bsky.yaml` (and `inbox-x.yaml` if X is configured).

### `feed`

Consumes timeline feeds. Default is the home/following timeline.

```bash
void feed
void feed --type discover
void feed --limit 20
```

| Flag | Description |
|------|-------------|
| `--type <feed>` | `home` (default) or `discover` for the discover/algorithmic feed |
| `--limit <n>` | Number of items to return (default: 10) |

### `monitor`

Runs the horizon radar — a continuous watch for new activity across configured platforms.

```bash
void monitor
void monitor --interval 60
void monitor --once
```

| Flag | Description |
|------|-------------|
| `--interval <seconds>` | Poll interval in seconds (default: 300) |
| `--once` | Single check, then exit |

### `ingest-thread`

Archives a full thread (post + all replies) into a local YAML file for offline reference.

```bash
void ingest-thread <uri-or-url>
void ingest-thread https://bsky.app/profile/example/post/3k...
void ingest-thread at://did:plc:.../app.bsky.feed.post/3k...
```

| Argument | Description |
|----------|-------------|
| `<uri-or-url>` | AT URI or bsky.app URL of the root post |

Output is written to a thread archive file under the configured data directory.

### `post`

Creates a new post. Supports quotes, replies, and facets.

```bash
void post "Hello world"
void post "Replying to this" --reply <uri>
void post "Quoting this" --quote <uri>
```

| Flag | Description |
|------|-------------|
| `--reply <uri>` | URI of the post to reply to |
| `--quote <uri>` | URI of the post to quote (embed as quote) |
| `--image <path>` | Attach an image |
| `--lang <code>` | Language code (e.g. `en`) |

### `dispatch`

Processes the outbox — reads pending posts from `outbox-bsky.yaml` (and `outbox-x.yaml`), publishes them, and records the result in `dispatch_history.yaml`.

```bash
void dispatch
void dispatch --dry-run
void dispatch --source bsky
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Validate outbox entries without publishing |
| `--source <platform>` | Limit dispatch to `bsky` or `x` |

### `block`

Blocks a user by DID or handle.

```bash
void block <did-or-handle>
void block did:plc:abc123...
void block @example.bsky.social
```

| Argument | Description |
|----------|-------------|
| `<did-or-handle>` | AT DID or handle of the account to block |

## Key File Paths

All paths are relative to the void data directory (configured in `config.yaml`).

| File | Purpose |
|------|---------|
| `config.yaml` | Main configuration — platform credentials, data directory, sync preferences |
| `inbox-bsky.yaml` | Bluesky notification inbox (populated by `sync`) |
| `outbox-bsky.yaml` | Bluesky outbox — posts queued for dispatch |
| `dispatch_history.yaml` | Record of all dispatched posts with timestamps and results |

## outbox.yaml Schema

Entries in `outbox-bsky.yaml` (and `outbox-x.yaml`):

```yaml
- id: <uuid>                    # Unique entry ID
  text: "Post content"          # Post body text
  type: post                    # post | reply | quote
  reply_to: <uri>               # (reply) URI of parent post
  quote_uri: <uri>              # (quote) URI of quoted post
  image: <path>                 # (optional) Path to attached image
  lang: en                      # (optional) Language code
  created_at: <iso-timestamp>   # When the entry was created
  status: pending               # pending | dispatched | failed
  dispatched_at: <iso-timestamp># (dispatched) When it was sent
  error: <message>              # (failed) Error message
```

`void dispatch` reads entries with `status: pending`, publishes them, and updates `status`, `dispatched_at`, and `error` fields accordingly. Successfully dispatched entries are also appended to `dispatch_history.yaml`.
