export interface GetCwdMapCommand {
  type: "get_cwd_map";
  request_id: string;
}

export interface GetCwdMapResponseMessage {
  type: "get_cwd_map_response";
  request_id: string;
  success: boolean;
  cwd_map: Record<string, string>;
  boot_working_directory: string | null;
  error?: string;
}

export interface SetBootWorkingDirectoryCommand {
  type: "set_boot_working_directory";
  request_id: string;
  cwd: string;
}

export interface SetBootWorkingDirectoryResponseMessage {
  type: "set_boot_working_directory_response";
  request_id: string;
  success: boolean;
  boot_working_directory: string;
  cwd_revision: number;
  error?: string;
}
