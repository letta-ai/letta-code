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

class SedScriptParser {
  private cursor = 0;

  constructor(private readonly script: string) {}

  parse(): boolean {
    return this.parseStatements(false) && this.cursor === this.script.length;
  }

  private skipSpaces(): void {
    while (
      this.script[this.cursor] === " " ||
      this.script[this.cursor] === "\t"
    ) {
      this.cursor += 1;
    }
  }

  private parseStatements(inBlock: boolean): boolean {
    while (this.cursor < this.script.length) {
      this.skipSpaces();
      while (/^[;\n]$/.test(this.script[this.cursor] ?? "")) {
        this.cursor += 1;
        this.skipSpaces();
      }
      if (inBlock && this.script[this.cursor] === "}") {
        this.cursor += 1;
        return true;
      }
      if (this.cursor === this.script.length) return !inBlock;
      if (!this.parseStatement()) return false;
      this.skipSpaces();
      const next = this.script[this.cursor];
      if (next !== undefined && next !== ";" && next !== "\n" && next !== "}") {
        return false;
      }
    }
    return !inBlock;
  }

  private parseStatement(): boolean {
    this.parseAddressRange();
    this.skipSpaces();
    if (this.script[this.cursor] === "!") {
      this.cursor += 1;
      this.skipSpaces();
    }

    const command = this.script[this.cursor++];
    if (!command) return false;
    if (command === "{") return this.parseStatements(true);
    if (command === "s") return this.parseSubstitution();
    if (command === "y") return this.parseDelimitedFields(2);
    if (command === "#") {
      while (
        this.cursor < this.script.length &&
        this.script[this.cursor] !== "\n"
      ) {
        this.cursor += 1;
      }
      return true;
    }
    if (command === ":" || "btT".includes(command)) {
      while (/^[^;\n}\s]$/.test(this.script[this.cursor] ?? "")) {
        this.cursor += 1;
      }
      return true;
    }
    return "pPl=nNdDqQgGhHxz".includes(command);
  }

  private parseAddressRange(): void {
    const start = this.cursor;
    if (!this.parseAddress()) return;
    this.skipSpaces();
    if (this.script[this.cursor] !== ",") return;
    this.cursor += 1;
    this.skipSpaces();
    if (/^[+~]$/.test(this.script[this.cursor] ?? "")) {
      this.cursor += 1;
      if (!this.parseDigits()) this.cursor = start;
    } else if (!this.parseAddress()) this.cursor = start;
  }

  private parseAddress(): boolean {
    if (this.script[this.cursor] === "$") {
      this.cursor += 1;
      return true;
    }
    if (this.script[this.cursor] === "/") return this.parseRegex("/");
    if (this.script[this.cursor] === "\\") {
      const delimiter = this.script[this.cursor + 1];
      if (!delimiter || delimiter === "\n" || delimiter === "\\") return false;
      this.cursor += 2;
      return this.parseUntilDelimiter(delimiter);
    }
    if (!this.parseDigits()) return false;
    if (this.script[this.cursor] === "~") {
      this.cursor += 1;
      return this.parseDigits();
    }
    return true;
  }

  private parseRegex(delimiter: string): boolean {
    this.cursor += 1;
    return this.parseUntilDelimiter(delimiter);
  }

  private parseDigits(): boolean {
    const start = this.cursor;
    while (/^\d$/.test(this.script[this.cursor] ?? "")) this.cursor += 1;
    return this.cursor > start;
  }

  private parseUntilDelimiter(delimiter: string): boolean {
    while (this.cursor < this.script.length) {
      if (this.script[this.cursor] === "\\") this.cursor += 2;
      else if (this.script[this.cursor] === delimiter) {
        this.cursor += 1;
        return true;
      } else if (this.script[this.cursor] === "\n") return false;
      else this.cursor += 1;
    }
    return false;
  }

  private parseDelimitedFields(fieldCount: number): boolean {
    const delimiter = this.script[this.cursor];
    if (!delimiter || /[\\\n;]/.test(delimiter)) return false;
    this.cursor += 1;
    for (let field = 0; field < fieldCount; field += 1) {
      if (!this.parseUntilDelimiter(delimiter)) return false;
    }
    return true;
  }

  private parseSubstitution(): boolean {
    if (!this.parseDelimitedFields(2)) return false;
    while (/^[gpiImM\d]$/.test(this.script[this.cursor] ?? "")) {
      this.cursor += 1;
    }
    return true;
  }
}

function hasUnsafeSedScript(script: string): boolean {
  return !new SedScriptParser(script).parse();
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

function getSedInputFiles(args: string[]): string[] {
  const files: string[] = [];
  let hasScript = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      if (!hasScript) {
        hasScript = true;
        index += 1;
      }
      files.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-e" || arg === "--expression") {
      hasScript = true;
      index += 1;
    } else if (arg.startsWith("--expression=")) hasScript = true;
    else if (/^-[^-]*e/.test(arg)) {
      hasScript = true;
      if (!arg.slice(arg.indexOf("e", 1) + 1)) index += 1;
    } else if (!arg.startsWith("-")) {
      if (hasScript) files.push(arg);
      else hasScript = true;
    }
  }
  return files;
}

export function hasUnsafeSedArgs(
  args: string[],
  isUnsafeInputFile: (file: string) => boolean = () => false,
): boolean {
  if (hasDeniedOption(args, "if", ["--in-place", "--file"])) return true;
  const scripts = getSedScripts(args);
  return (
    scripts === null ||
    scripts.some(hasUnsafeSedScript) ||
    getSedInputFiles(args).some(isUnsafeInputFile)
  );
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
