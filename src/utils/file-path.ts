import * as os from "node:os";
import * as path from "node:path";

export function expandFilePath(
  filePath: string,
  userCwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  let expanded = filePath;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(homeDir, expanded.slice(1));
  }

  expanded = expanded.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, unbraced?: string) => {
      const name = braced ?? unbraced ?? "";
      return env[name] ?? match;
    },
  );

  return path.isAbsolute(expanded) ? expanded : path.resolve(userCwd, expanded);
}
