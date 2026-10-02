import { describe, expect, test } from "bun:test";
import {
  advanceDiskPressure,
  classifyDiskPressure,
  createDiskPressureState,
  type DiskSpaceSample,
  formatLowDiskSpaceReminder,
  measureDiskSpace,
} from "@/reminders/disk-space";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function sampleAt(usedPercent: number, totalBytes = 100 * GIB) {
  return {
    path: "/work",
    totalBytes,
    availableBytes: totalBytes * (1 - usedPercent / 100),
  } satisfies DiskSpaceSample;
}

describe("classifyDiskPressure", () => {
  test("warning at 85% used or under 2 GiB free", () => {
    expect(classifyDiskPressure(sampleAt(84))).toBe("ok");
    expect(classifyDiskPressure(sampleAt(85))).toBe("warning");
    // 12 GiB volume with 1.9 GiB free is only 84% used.
    expect(
      classifyDiskPressure({
        path: "/",
        totalBytes: 12 * GIB,
        availableBytes: 1.9 * GIB,
      }),
    ).toBe("warning");
  });

  test("critical at 95% used or under 512 MiB free", () => {
    expect(classifyDiskPressure(sampleAt(95))).toBe("critical");
    expect(
      classifyDiskPressure({
        path: "/",
        totalBytes: 4 * GIB,
        availableBytes: 500 * MIB,
      }),
    ).toBe("critical");
  });

  test("an empty or unreadable volume is never low", () => {
    expect(
      classifyDiskPressure({ path: "/", totalBytes: 0, availableBytes: 0 }),
    ).toBe("ok");
  });
});

describe("advanceDiskPressure hysteresis", () => {
  function run(percents: number[]) {
    let state = createDiskPressureState();
    const fired: Array<string | null> = [];
    for (const percent of percents) {
      const next = advanceDiskPressure(state, sampleAt(percent));
      state = next.state;
      fired.push(next.fire);
    }
    return fired;
  }

  test("each escalation fires once", () => {
    expect(run([80, 86, 88, 90, 96, 99, 100])).toEqual([
      null,
      "warning",
      null,
      null,
      "critical",
      null,
      null,
    ]);
  });

  test("jumping straight to critical does not fire a later warning", () => {
    expect(run([96, 92, 86])).toEqual(["critical", null, null]);
  });

  test("critical re-arms only after dropping below its re-arm mark", () => {
    // 92% is below critical but above the 90% re-arm mark.
    expect(run([96, 92, 96])).toEqual(["critical", null, null]);
    expect(run([96, 89, 96])).toEqual(["critical", null, "critical"]);
  });

  test("warning re-arms only after dropping below its re-arm mark", () => {
    expect(run([86, 82, 86])).toEqual(["warning", null, null]);
    expect(run([86, 79, 86])).toEqual(["warning", null, "warning"]);
  });
});

describe("formatLowDiskSpaceReminder", () => {
  test("is a system reminder with usage, cleanup targets, and what to keep", () => {
    const text = formatLowDiskSpaceReminder("warning", sampleAt(88, 20 * GIB));
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text).toContain("88% full (2.4 GB available of 20.0 GB)");
    for (const target of [
      "node_modules",
      "_cacache",
      "bun",
      "pip",
      "uv",
      "dist/",
      "/tmp",
      "git worktree remove",
      "Pause large installs and builds",
      "Keep source files, uncommitted changes",
    ]) {
      expect(text).toContain(target);
    }
  });
});

describe("measureDiskSpace", () => {
  test("reads the real volume holding a directory", async () => {
    const sample = await measureDiskSpace(process.cwd());
    expect(sample.totalBytes).toBeGreaterThan(0);
    expect(sample.availableBytes).toBeGreaterThanOrEqual(0);
  });
});
