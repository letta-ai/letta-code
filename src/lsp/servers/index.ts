/**
 * LSP Server Registry
 */

import type { LSPServerInfo } from "../types.js";
import { PythonServer } from "./python.js";
import { TypeScriptServer } from "./typescript.js";

/**
 * All available LSP servers
 * Add new servers here as they are implemented
 */
export const SERVERS: LSPServerInfo[] = [TypeScriptServer, PythonServer];
