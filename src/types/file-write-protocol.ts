export interface WriteFileCommand {
  type: "write_file";
  /** Absolute path to the file to write. */
  path: string;
  /** The full file content to write (base64 bytes when `encoding` is "base64"). */
  content: string;
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /**
   * Defaults to "utf8" (written through the Write/Edit tools). "base64" writes
   * the decoded bytes directly, creating parent directories; `path` may then
   * start with `~/`. Advertised as `capabilities.write_file_base64`.
   */
  encoding?: "utf8" | "base64";
  /**
   * base64 only: append to the file so large files can arrive in chunks.
   * Commands run detached, so chunked writers must await each chunk's
   * `write_file_response` before sending the next one.
   */
  append?: boolean;
  /**
   * base64 only: after writing, rename the file to this path (absolute or
   * `~/`), replacing any existing file. Lets chunked writers assemble under a
   * unique temporary name and publish the finished file atomically.
   */
  move_to?: string;
}

export interface WriteFileResponseMessage {
  type: "write_file_response";
  request_id: string;
  /**
   * Resolved absolute path for base64 writes (the `move_to` destination when
   * given); otherwise the requested path.
   */
  path: string;
  /** base64 only: number of decoded bytes written by this command. */
  bytes_written?: number;
  success: boolean;
  error?: string;
}
