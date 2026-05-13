import { beforeEach, describe, expect, mock, test } from "bun:test";

const getSettingsMock = mock(() => ({}));
const updateSettingsMock = mock(async () => undefined);
const getVersionMock = mock(() => "0.25.7");

mock.module("../settings-manager", () => ({
  settingsManager: {
    getSettings: getSettingsMock,
    updateSettings: updateSettingsMock,
  },
}));

mock.module("../version", () => ({
  getVersion: getVersionMock,
}));

const { checkReleaseNotes, getReleaseNotes } = await import("../release-notes");

describe("release notes", () => {
  beforeEach(() => {
    getSettingsMock.mockReset();
    updateSettingsMock.mockReset();
    getVersionMock.mockReset();
    getSettingsMock.mockReturnValue({});
    getVersionMock.mockReturnValue("0.25.7");
    delete process.env.LETTA_SHOW_RELEASE_NOTES;
    delete process.env.LETTA_CODE_AGENT_ROLE;
  });

  test("includes permission mode startup note for 0.25.7", () => {
    const notes = getReleaseNotes("0.25.7");
    expect(notes).toContain("default permission mode is now **unrestricted**");
    expect(notes).toContain("Run **/permissions**");
    expect(notes).toContain("shift+tab");
  });

  test("shows release notes once for a new version and marks them seen", async () => {
    getSettingsMock.mockReturnValue({ lastSeenReleaseNotesVersion: "0.25.6" });

    const notes = await checkReleaseNotes();

    expect(notes).toContain("default permission mode is now **unrestricted**");
    expect(updateSettingsMock).toHaveBeenCalledWith({
      lastSeenReleaseNotesVersion: "0.25.7",
    });
  });

  test("does not show release notes when already seen for same base version", async () => {
    getSettingsMock.mockReturnValue({ lastSeenReleaseNotesVersion: "0.25.7" });

    const notes = await checkReleaseNotes();

    expect(notes).toBeNull();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
