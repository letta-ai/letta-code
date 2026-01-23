import * as path from "node:path";
import { read, type ToolReturnContent } from "./Read";
import { validateRequiredParams } from "./validation.js";

interface ViewImageArgs {
  path: string;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export async function view_image(
  args: ViewImageArgs,
): Promise<{ content: ToolReturnContent }> {
  validateRequiredParams(args, ["path"], "view_image");

  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(args.path)
    ? args.path
    : path.resolve(userCwd, args.path);

  if (!isImageFile(resolvedPath)) {
    throw new Error(`Unsupported image file type: ${resolvedPath}`);
  }

  const result = await read({ file_path: resolvedPath });
  return { content: result.content };
}
