
import type { LSPServerInfo } from "@/lsp/types.js";
import { PythonServer } from "./python.js";
import { TypeScriptServer } from "./typescript.js";

export const SERVERS: LSPServerInfo[] = [TypeScriptServer, PythonServer];
