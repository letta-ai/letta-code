import { loadPermissionMode } from "./loader";
import {
  migratePermissionMode,
  type PermissionMode,
  permissionMode,
  VALID_PERMISSION_MODES,
} from "./mode";

export type StartupPermissionModeResult =
  | {
      ok: true;
      mode: PermissionMode;
      source: "cli" | "settings" | "default";
    }
  | {
      ok: false;
      value: string;
      message: string;
    };

export function formatInvalidPermissionModeMessage(value: string): string {
  return `Invalid permission mode: ${value}. Valid modes: ${VALID_PERMISSION_MODES.join(", ")}`;
}

export async function applyStartupPermissionMode(options: {
  permissionModeValue?: string;
  yoloMode?: boolean;
  workingDirectory?: string;
}): Promise<StartupPermissionModeResult> {
  const { permissionModeValue, yoloMode = false } = options;

  if (yoloMode) {
    permissionMode.setMode("unrestricted");
    return { ok: true, mode: "unrestricted", source: "cli" };
  }

  if (permissionModeValue) {
    const migrated = migratePermissionMode(permissionModeValue);
    if (!migrated) {
      return {
        ok: false,
        value: permissionModeValue,
        message: formatInvalidPermissionModeMessage(permissionModeValue),
      };
    }
    permissionMode.setMode(migrated);
    return { ok: true, mode: migrated, source: "cli" };
  }

  const configuredMode = await loadPermissionMode(
    options.workingDirectory ?? process.cwd(),
  );
  if (configuredMode) {
    permissionMode.setMode(configuredMode);
    return { ok: true, mode: configuredMode, source: "settings" };
  }

  return { ok: true, mode: permissionMode.getMode(), source: "default" };
}
