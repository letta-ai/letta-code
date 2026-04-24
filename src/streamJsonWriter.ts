/**
 * Centralized writer for stream-json wire events emitted by headless.ts.
 *
 * Every line emitted to stdout in stream-json mode should go through this
 * helper rather than a raw `console.log(JSON.stringify(...))`. The helper:
 *
 * - Stamps `timestamp` at emit time (ISO 8601 UTC, ms precision) — this is
 *   CLI-emit time, not server-creation time. Field name and format match
 *   Claude Code and Codex stream-json output so downstream normalizers
 *   can treat all three CLIs uniformly.
 *
 * - Is the single choke point that enforces the on-wire invariant that
 *   every message has a `timestamp`. New call sites cannot forget it.
 *
 * Callers should construct wire messages without a `timestamp` field —
 * the writer fills it in. If a caller does pre-stamp `timestamp` (e.g. to
 * preserve a time captured earlier), that value is respected.
 *
 * `ControlRequest` does not extend `MessageEnvelope`, but when the CLI emits
 * one onto stdout it should still be timestamped like every other stream-json
 * wire event.
 */
import type { WireMessage } from "./types/protocol";

export function writeWireMessage(msg: WireMessage): void {
  // Strip the server-origin `date` field (second precision, +00:00) if
  // present. `timestamp` (CLI-stamped, ms + Z) is the canonical time source
  // for stream-json consumers; `date` is a redundant duplicate that diverges
  // on both field name and format.
  const { date: _date, ...withoutDate } = msg as typeof msg & {
    date?: string;
  };
  const stamped =
    withoutDate.timestamp === undefined
      ? { ...withoutDate, timestamp: new Date().toISOString() }
      : withoutDate;
  console.log(JSON.stringify(stamped));
}
