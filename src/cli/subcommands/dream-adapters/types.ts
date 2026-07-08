import type { ExternalTranscriptEntry } from "@/cli/helpers/reflection-transcript";

/**
 * A dream adapter converts an external trace format (identified by `type` in
 * `--from <type>:<locator>`) into transcript entries the reflection machinery
 * can process.
 *
 * To add a new dream source type (e.g. `claude`, `codex`): create a sibling file
 * exporting a `DreamAdapter` whose `convert(locator)` maps that tool's format
 * into `ExternalTranscriptEntry[]`, then register it in `ADAPTERS` (./index).
 */
export interface DreamAdapter {
  /** The scheme used in `--from <type>:<locator>`. */
  type: string;
  /** Read the located source and convert it into transcript entries. */
  convert(locator: string): Promise<ExternalTranscriptEntry[]>;
}
