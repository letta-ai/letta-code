import type {
  GetCwdMapCommand,
  SetBootWorkingDirectoryCommand,
} from "@/types/cwd-protocol";

export function isGetCwdMapCommand(value: unknown): value is GetCwdMapCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as { type?: unknown; request_id?: unknown };
  return (
    command.type === "get_cwd_map" && typeof command.request_id === "string"
  );
}

export function isSetBootWorkingDirectoryCommand(
  value: unknown,
): value is SetBootWorkingDirectoryCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    cwd?: unknown;
  };
  return (
    command.type === "set_boot_working_directory" &&
    typeof command.request_id === "string" &&
    command.request_id.length > 0 &&
    typeof command.cwd === "string"
  );
}
