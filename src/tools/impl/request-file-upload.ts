interface UploadedFile {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

interface RequestFileUploadArgs {
  message?: string;
  accept?: string;
  multiple?: boolean;
  files?: UploadedFile[];
}

interface RequestFileUploadResult {
  message: string;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<UploadedFile>;
  return (
    typeof file.path === "string" &&
    file.path.length > 0 &&
    typeof file.name === "string" &&
    file.name.length > 0 &&
    typeof file.mimeType === "string" &&
    file.mimeType.length > 0 &&
    typeof file.size === "number" &&
    Number.isFinite(file.size) &&
    file.size >= 0
  );
}

export async function request_file_upload(
  args: RequestFileUploadArgs,
): Promise<RequestFileUploadResult> {
  if (args.files === undefined) {
    return { message: "Waiting for user to upload files..." };
  }

  if (!Array.isArray(args.files)) {
    throw new Error("files must contain valid uploaded file metadata");
  }
  if (args.files.length === 0) {
    return { message: "Waiting for user to upload files..." };
  }
  if (!args.files.every(isUploadedFile)) {
    throw new Error("files must contain valid uploaded file metadata");
  }

  const paths = args.files.map((file) => `- ${file.path}`).join("\n");
  return {
    message: `User uploaded ${args.files.length === 1 ? "a file" : `${args.files.length} files`}:\n${paths}`,
  };
}
