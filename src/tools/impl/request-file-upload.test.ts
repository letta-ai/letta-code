import { describe, expect, test } from "bun:test";
import { request_file_upload } from "./request-file-upload";

describe("request_file_upload", () => {
  test("waits while the user has not uploaded files", async () => {
    await expect(
      request_file_upload({ message: "Upload the report" }),
    ).resolves.toEqual({
      message: "Waiting for user to upload files...",
    });
  });

  test("returns uploaded sandbox paths to the model", async () => {
    await expect(
      request_file_upload({
        multiple: true,
        files: [
          {
            path: "/root/downloads/upload-1/report.pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
          {
            path: "/root/downloads/upload-1/notes.txt",
            name: "notes.txt",
            mimeType: "text/plain",
            size: 128,
          },
        ],
      }),
    ).resolves.toEqual({
      message:
        "User uploaded 2 files:\n- /root/downloads/upload-1/report.pdf\n- /root/downloads/upload-1/notes.txt",
    });
  });

  test("rejects malformed UI-injected metadata", async () => {
    await expect(
      request_file_upload({
        files: [
          {
            path: "",
            name: "report.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
        ],
      }),
    ).rejects.toThrow("files must contain valid uploaded file metadata");
  });
});
