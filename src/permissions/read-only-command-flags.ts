function matchesLongOption(token: string, option: string): boolean {
  if (!token.startsWith("--")) return false;
  const name = token.split("=", 1)[0] ?? token;
  return name.length > 2 && option.startsWith(name);
}

function hasDeniedOption(
  args: string[],
  shortOptions: string,
  longOptions: string[],
): boolean {
  return args.some((arg) => {
    if (arg.startsWith("--")) {
      return longOptions.some((option) => matchesLongOption(arg, option));
    }
    return (
      arg.startsWith("-") &&
      !arg.startsWith("--") &&
      [...arg.slice(1)].some((flag) => shortOptions.includes(flag))
    );
  });
}

function countXxdPositionalArgs(args: string[]): number {
  const optionsWithValues = new Set([
    "-c",
    "-cols",
    "-g",
    "-groupsize",
    "-l",
    "-len",
    "-s",
    "-seek",
  ]);
  let count = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (optionsWithValues.has(arg)) index += 1;
    else if (!arg.startsWith("-")) count += 1;
  }
  return count;
}

export function hasUnsafeSafeListCommandFlags(
  command: string,
  args: string[],
): boolean {
  if (command === "tree") return hasDeniedOption(args, "oR", []);
  if (command === "yq") return hasDeniedOption(args, "i", ["--inplace"]);
  if (command === "xxd") return countXxdPositionalArgs(args) > 1;
  if (command === "less") {
    return (
      hasDeniedOption(args, "oO", ["--log-file"]) ||
      args.some((arg) => arg.startsWith("+"))
    );
  }
  return false;
}

function stripSedAddresses(script: string): string {
  const address = String.raw`(?:\d+|\$|\/(?:\\.|[^/])*\/)`;
  return script.replace(
    new RegExp(`^\\s*${address}(?:\\s*,\\s*${address})?\\s*`),
    "",
  );
}

function hasUnsafeSedScript(script: string): boolean {
  return script.split(/[;\n{}]/).some((statement) => {
    const command = stripSedAddresses(statement);
    if (/^[ewW](?:\s|$)/.test(command)) return true;
    if (!command.startsWith("s") || command.length < 2) return false;

    const delimiter = command[1];
    if (!delimiter || /[\\\n]/.test(delimiter)) return false;
    let cursor = 2;
    for (let field = 0; field < 2; field += 1) {
      let foundDelimiter = false;
      while (cursor < command.length) {
        if (command[cursor] === "\\") cursor += 2;
        else if (command[cursor] === delimiter) {
          cursor += 1;
          foundDelimiter = true;
          break;
        } else cursor += 1;
      }
      if (!foundDelimiter) return false;
    }
    return /[ewW]/.test(command.slice(cursor).trim());
  });
}

function getSedScripts(args: string[]): string[] | null {
  const scripts: string[] = [];
  let hasScript = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      if (!hasScript && args[index + 1]) scripts.push(args[index + 1] ?? "");
      break;
    }
    if (arg === "-e" || arg === "--expression") {
      const script = args[++index];
      if (!script) return null;
      scripts.push(script);
      hasScript = true;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      hasScript = true;
    } else if (/^-[^-]*e/.test(arg)) {
      const attached = arg.slice(arg.indexOf("e", 1) + 1);
      const script = attached || args[++index];
      if (!script) return null;
      scripts.push(script);
      hasScript = true;
    } else if (!arg.startsWith("-") && !hasScript) {
      scripts.push(arg);
      hasScript = true;
    }
  }
  return scripts;
}

export function hasUnsafeSedArgs(args: string[]): boolean {
  if (hasDeniedOption(args, "if", ["--in-place", "--file"])) return true;
  const scripts = getSedScripts(args);
  return scripts === null || scripts.some(hasUnsafeSedScript);
}

export function hasUnsafeSortArgs(args: string[]): boolean {
  return hasDeniedOption(args, "o", ["--output", "--compress-program"]);
}

export function isReadOnlyGitTagArgs(args: string[]): boolean {
  if (args.length === 0) return true;
  if (
    hasDeniedOption(args, "dasfmFu", [
      "--delete",
      "--annotate",
      "--sign",
      "--force",
      "--message",
      "--file",
      "--local-user",
    ])
  ) {
    return false;
  }

  const filters = [
    "--contains",
    "--points-at",
    "--merged",
    "--no-merged",
    "--sort",
    "--format",
  ];
  let listing = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-l" || matchesLongOption(arg, "--list")) listing = true;
    else if (filters.some((option) => matchesLongOption(arg, option))) {
      listing = true;
      if (
        !arg.includes("=") &&
        args[index + 1] &&
        !args[index + 1]?.startsWith("-")
      ) {
        index += 1;
      }
    } else if (arg.startsWith("-") || !listing) return false;
  }
  return listing;
}

export function isReadOnlyGitBranchArgs(args: string[]): boolean {
  if (args.length === 0) return true;
  const readOnlyFlags = new Set([
    "--list",
    "-l",
    "--show-current",
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "-vv",
    "--verbose",
  ]);
  const filterFlags = new Set([
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
  ]);
  let sawReadOnlyFlag = false;
  let sawListFlag = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (readOnlyFlags.has(arg)) {
      sawReadOnlyFlag = true;
      if (arg === "--list" || arg === "-l") sawListFlag = true;
    } else if (arg === "--format") {
      if (!args[index + 1]) return false;
      sawReadOnlyFlag = true;
      index += 1;
    } else if (arg.startsWith("--format=")) sawReadOnlyFlag = true;
    else if (filterFlags.has(arg)) {
      sawReadOnlyFlag = true;
      if (args[index + 1] && !args[index + 1]?.startsWith("-")) index += 1;
    } else if (sawListFlag && !arg.startsWith("-")) sawReadOnlyFlag = true;
    else return false;
  }
  return sawReadOnlyFlag;
}

export function isReadOnlyGitRemoteArgs(args: string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === "-v")) {
    return true;
  }
  const action = args[args[0] === "-v" ? 1 : 0];
  return action === "show" || action === "get-url";
}
