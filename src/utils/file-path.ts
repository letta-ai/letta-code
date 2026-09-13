import * as os from "node:os";
import * as path from "node:path";

/**
 * Expand a file_path argument before resolving it:
 * 1. Expand leading `~` to the home directory.
 * 2. Expand `$VAR` and `${VAR}` references using process.env (fallback: leave
 *    the token as-is so the downstream error message is still readable).
 * 3. Resolve relative paths against `userCwd`.
 */
export function expandFilePath(filePath: string, userCwd: string): string {
  // 1. Tilde expansion
  let expanded = filePath;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  // 2. Environment-variable expansion ($VAR and ${VAR})
  expanded = expanded.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, unbraced?: string) => {
      const name = braced ?? unbraced ?? "";
      return process.env[name] ?? match; // leave unresolved vars intact
    },
  );

  // 3. Absolute vs relative
  return path.isAbsolute(expanded) ? expanded : path.resolve(userCwd, expanded);
}
