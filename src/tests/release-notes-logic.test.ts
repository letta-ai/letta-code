import { describe, expect, test } from "bun:test";

import {
  getPendingReleaseNotes,
  getPendingReleaseNoteVersions,
} from "../release-notes";

describe("release notes logic", () => {
  test("shows only the current version note when there is no seen checkpoint", () => {
    expect(getPendingReleaseNoteVersions("0.25.7")).toEqual(["0.25.7"]);
    expect(getPendingReleaseNoteVersions("0.25.8")).toEqual([]);
  });

  test("backfills skipped notes across a version range", () => {
    expect(getPendingReleaseNoteVersions("0.25.9", "0.25.4")).toEqual([
      "0.25.7",
    ]);
  });

  test("includes multiple skipped notes in chronological order", () => {
    expect(getPendingReleaseNoteVersions("0.13.4", "0.12.9")).toEqual([
      "0.13.0",
      "0.13.4",
    ]);
  });

  test("does not re-show notes once the checkpoint has already passed them", () => {
    expect(getPendingReleaseNoteVersions("0.25.9", "0.25.7")).toEqual([]);
    expect(getPendingReleaseNoteVersions("0.25.9", "0.25.9")).toEqual([]);
  });

  test("compares prerelease versions by their base version", () => {
    expect(
      getPendingReleaseNoteVersions("0.25.9-next.3", "0.25.4-next.2"),
    ).toEqual(["0.25.7"]);
  });

  test("renders all unseen notes with blank line separation", () => {
    const notes = getPendingReleaseNotes("0.13.4", "0.12.9");
    expect(notes).toContain("Letta Code 0.13.0");
    expect(notes).toContain("Letta Code 0.13.4");
    expect(notes).toContain("\n\n🔄 **Letta Code 0.13.4");
  });
});
