export interface UpdatePolicyTarget {
  allowDowngrade: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
}

/** Apply the release channel without inheriting electron-updater's downgrade opt-in. */
export function configureUpdatePolicy(
  updater: UpdatePolicyTarget,
  architecture: string,
): void {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // electron-updater's channel setter enables allowDowngrade, so this
  // assignment must remain before the explicit false below.
  updater.channel = architecture === "arm64" ? "latest-arm64" : "latest";
  updater.allowDowngrade = false;
}
