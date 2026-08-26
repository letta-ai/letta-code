import { describe, expect, test } from "bun:test";
import {
  WORKLOAD_SYSTEMD_SLICE_ENV,
  wrapManagedWorkloadLauncher,
} from "@/utils/systemd-workload-scope";

describe("managed workload systemd scope", () => {
  test("leaves ordinary launchers unchanged", () => {
    const launcher = ["bash", "-lc", "printf ok"];

    expect(
      wrapManagedWorkloadLauncher(launcher, {
        env: {},
        platform: "linux",
      }),
    ).toBe(launcher);
  });

  test("does not wrap non-Linux launchers", () => {
    const launcher = ["bash", "-lc", "printf ok"];

    expect(
      wrapManagedWorkloadLauncher(launcher, {
        env: { [WORKLOAD_SYSTEMD_SLICE_ENV]: "letta-workload.slice" },
        platform: "darwin",
      }),
    ).toBe(launcher);
  });

  test("preserves an empty launcher", () => {
    const launcher: string[] = [];

    expect(
      wrapManagedWorkloadLauncher(launcher, {
        env: { [WORKLOAD_SYSTEMD_SLICE_ENV]: "letta-workload.slice" },
        platform: "linux",
      }),
    ).toBe(launcher);
  });

  test("places the complete launcher in the configured slice", () => {
    expect(
      wrapManagedWorkloadLauncher(["bash", "-lc", "printf ok"], {
        env: {
          [WORKLOAD_SYSTEMD_SLICE_ENV]: "  letta-workload.slice  ",
        },
        platform: "linux",
      }),
    ).toEqual([
      "systemd-run",
      "--scope",
      "--quiet",
      "--collect",
      "--slice=letta-workload.slice",
      "--",
      "bash",
      "-lc",
      "printf ok",
    ]);
  });
});
