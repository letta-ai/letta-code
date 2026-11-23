export interface WriteFileCommand {
  type: "write_file";
  path: string;
  content: string;
  request_id: string;
  encoding?: "utf8" | "base64";
  append?: boolean;
  move_to?: string;
}

export interface WriteFileResponseMessage {
  type: "write_file_response";
  request_id: string;
  path: string;
  bytes_written?: number;
  success: boolean;
  error?: string;
}
