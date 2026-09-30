import { describe, expect, test } from "bun:test";
import {
  configureUpdatePolicy,
  type UpdatePolicyTarget,
} from "./update-policy";

function createUpdater(): UpdatePolicyTarget {
  let channel: string | null = null;
  const updater = {
    allowDowngrade: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    get channel() {
      return channel;
    },
    set channel(value: string | null) {
      channel = value;
      this.allowDowngrade = true;
    },
  };
  return updater;
}

describe("configureUpdatePolicy", () => {
  test("disables downgrades after selecting the architecture channel", () => {
    const updater = createUpdater();

    configureUpdatePolicy(updater, "arm64");

    expect(updater.channel).toBe("latest-arm64");
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });
});
