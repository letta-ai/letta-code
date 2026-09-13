import {
  permissionMode as globalPermissionMode,
  type PermissionMode,
} from "@/permissions/mode";

/** Mutable, shared-by-reference permission mode state. */
export type PermissionModeState = {
  mode: PermissionMode;
};

export function getEffectivePermissionModeState(
  permissionModeState?: PermissionModeState,
): PermissionModeState {
  return (
    permissionModeState ?? {
      get mode() {
        return globalPermissionMode.getMode();
      },
      set mode(value: PermissionMode) {
        globalPermissionMode.setMode(value);
      },
    }
  );
}
