export interface GetCwdMapCommand {
  type: "get_cwd_map";
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface GetCwdMapResponseMessage {
  type: "get_cwd_map_response";
  request_id: string;
  success: boolean;
  /** Persisted per-conversation CWD overrides, keyed by listener scope key. */
  cwd_map: Record<string, string>;
  /** Listener boot CWD used when a conversation has no entry in cwd_map. */
  boot_working_directory: string | null;
  error?: string;
}

export interface SetBootWorkingDirectoryCommand {
  type: "set_boot_working_directory";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Directory used by conversations without a CWD override. */
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
