// Classify why a Bash command was denied under permission_mode=memory and
// produce a human-readable reason string the agent can use to recover.
//
// This is a heuristic labeller, not a permission check — it runs only after
// the actual `isScopedMemoryShellCommand` validator has already returned
// false, and its job is to tell the agent WHY (cmdsub vs. unsafe binary vs.
// redirect outside roots, etc.) and WHAT to do instead. False positives are
// acceptable: a slightly-off hint is still better than the previous bare
// "Permission mode: memory" message.

const ALLOWED_BINARIES =
  "cat, echo, printf, mkdir, rm, mv, cp, ls, find, sort, head, tail, wc, split, cd, sleep, git";

// Binaries that the rollout-style "Bash-only" prompt advertises but that the
// memory-mode allowlist does not include. Listing them explicitly lets us
// produce a targeted hint ("don't use python3, use cat heredoc") instead of a
// generic one.
const TEMPTING_UNSAFE_BINARIES = new Set([
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "bash",
  "sh",
  "zsh",
  "fish",
  "ksh",
  "dash",
  "eval",
  "exec",
  "source",
  ".",
  "sed",
  "awk",
  "tee",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "netcat",
  "ftp",
  "telnet",
  "make",
  "cmake",
  "docker",
  "kubectl",
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "go",
  "java",
  "javac",
  "mvn",
  "gradle",
  "gcc",
  "g++",
  "clang",
  "rustc",
]);

export type MemoryBashDenialCategory =
  | "cmdsub"
  | "unsafe-cmd"
  | "redirect-outside-roots"
  | "path-outside-roots"
  | "other";

export interface MemoryBashDenialClassification {
  category: MemoryBashDenialCategory;
  reason: string;
}

export interface ClassifyOptions {
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Inspect a Bash command and label the most likely reason it was denied
 * under memory mode. Returns a category + a reason string that names the
 * recommended alternative idiom.
 */
export function classifyMemoryBashDenial(
  command: string | string[],
  allowedRoots: string[],
  options: ClassifyOptions = {},
): MemoryBashDenialClassification {
  const text = Array.isArray(command) ? command.join(" ") : command;
  const env = options.env ?? process.env;

  // Order matters: cmdsub is the most actionable signal (fix is to use $VAR
  // directly) and is reliably detectable. Unsafe-cmd is next because the
  // remediation is concrete (use heredoc instead). Redirect/path checks come
  // after because they require path resolution and can false-positive.

  const cmdsubMatch = findUnquotedCommandSubstitution(text);
  if (cmdsubMatch) {
    const example = cmdsubMatch === "`" ? "`cmd`" : "$(cmd)";
    return {
      category: "cmdsub",
      reason:
        `Memory mode does not allow command substitution (\`${example}\`) ` +
        `or arbitrary code execution. Use variables directly: ` +
        `\`$LETTA_AGENT_ID\`, not \`$(echo $LETTA_AGENT_ID)\`. If you need ` +
        `to embed dynamic values in strings, set them as variables first ` +
        `(\`agent_id=$LETTA_AGENT_ID\`) and reference \`$agent_id\` inline.`,
    };
  }

  const unsafeBinary = findUnsafeBinary(text);
  if (unsafeBinary) {
    return {
      category: "unsafe-cmd",
      reason:
        `Memory mode does not allow \`${unsafeBinary}\`. To write files, use ` +
        `a heredoc: \`cat > "$MEMORY_DIR/path/to/file" << 'EOF' ... EOF\`. ` +
        `For multi-file writes, issue separate Bash calls. Allowed binaries: ` +
        `${ALLOWED_BINARIES}.`,
    };
  }

  const redirect = findOutsideRedirectTarget(text, allowedRoots, env);
  if (redirect) {
    return {
      category: "redirect-outside-roots",
      reason:
        `Memory mode allows shell redirects only to paths under ` +
        `\`$MEMORY_DIR\`. Got target: \`${redirect}\`. Use a path under ` +
        `\`$MEMORY_DIR\`, e.g. \`> "$MEMORY_DIR/system/foo.md"\`.`,
    };
  }

  if (hasPathOutsideRoots(text, allowedRoots, env)) {
    return {
      category: "path-outside-roots",
      reason:
        `Memory mode requires shell commands to operate on paths under ` +
        `\`$MEMORY_DIR\`. Prefix with \`cd "$MEMORY_DIR"\` or use absolute ` +
        `paths under it.`,
    };
  }

  return {
    category: "other",
    reason:
      `Memory mode denied this Bash command. Allowed shapes: read-only ` +
      `shell commands, or commands that operate inside \`$MEMORY_DIR\` ` +
      `(${ALLOWED_BINARIES}). For writes, use heredocs: ` +
      `\`cat > "$MEMORY_DIR/path" << 'EOF' ... EOF\`.`,
  };
}

/**
 * Scan for `$(` or backtick command substitution that is NOT inside a
 * single-quoted region. Heredoc bodies are not stripped — substitutions
 * inside heredoc bodies still count, since bash expands them at runtime.
 * (Single quotes around heredoc delimiters do prevent expansion, but for
 * the classifier we err on the side of flagging it.)
 *
 * Returns the matched literal (`$(` or `` ` ``) for use in the reason text,
 * or null if no unquoted substitution is found.
 */
function findUnquotedCommandSubstitution(input: string): string | null {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < input.length) {
    const ch = input[i];
    if (!ch) {
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length && !inSingle) {
      i += 2;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i += 1;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i += 1;
      continue;
    }

    // $(...) is expanded inside double quotes too, only single quotes inhibit.
    if (!inSingle && ch === "$" && input.startsWith("$(", i)) {
      return "$(";
    }
    if (!inSingle && ch === "`") {
      return "`";
    }

    i += 1;
  }
  return null;
}

/**
 * Find the first segment whose leading verb is in the
 * `TEMPTING_UNSAFE_BINARIES` set. Segments are split on `;`, `&&`, `||`, `|`,
 * and newlines, respecting single/double quotes. Heredoc bodies are skipped
 * so the classifier doesn't pick up command names that appear in file
 * contents.
 */
function findUnsafeBinary(input: string): string | null {
  for (const segment of splitSegmentsForClassifier(input)) {
    const trimmed = segment.trimStart();
    if (!trimmed) continue;

    // Skip leading env-var assignments: `FOO=bar BAZ=qux command ...`
    let rest = trimmed;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
      const spaceIdx = rest.search(/\s/);
      if (spaceIdx === -1) break;
      rest = rest.slice(spaceIdx).trimStart();
    }
    if (!rest) continue;

    const verbMatch = rest.match(/^([^\s;|&<>()]+)/);
    if (!verbMatch) continue;
    const verb = verbMatch[1];
    if (!verb) continue;
    // Strip absolute path prefix: /usr/bin/python3 -> python3
    const baseVerb = verb.includes("/") ? (verb.split("/").pop() ?? "") : verb;
    if (TEMPTING_UNSAFE_BINARIES.has(baseVerb)) {
      return baseVerb;
    }
  }
  return null;
}

/**
 * Look for `>` or `>>` redirect operators (outside single quotes and outside
 * heredoc bodies) and check whether the redirect target resolves outside the
 * allowed roots. Returns the offending target string for the reason text, or
 * null if every redirect target is inside roots (or there are no redirects,
 * or the targets cannot be resolved without execution).
 */
function findOutsideRedirectTarget(
  input: string,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const stripped = stripHeredocBodies(input);
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (!ch) {
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < stripped.length && !inSingle) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i += 1;
      continue;
    }

    if (
      !inSingle &&
      !inDouble &&
      (ch === ">" || stripped.startsWith(">>", i))
    ) {
      const op = stripped.startsWith(">>", i) ? ">>" : ">";
      let cursor = i + op.length;
      // Skip & for fd-dup like `>&2` — not a path target.
      if (stripped[cursor] === "&") {
        i = cursor + 1;
        continue;
      }
      while (cursor < stripped.length && /\s/.test(stripped[cursor] ?? "")) {
        cursor += 1;
      }
      const targetStart = cursor;
      const target = readToken(stripped, cursor);
      if (!target) {
        i = cursor + 1;
        continue;
      }
      const expanded = expandSimpleEnv(target.value, env);
      if (expanded === "/dev/null" || /^&\d+$/.test(expanded)) {
        i = target.end;
        continue;
      }
      if (!isPathInsideRoots(expanded, allowedRoots)) {
        return stripped.slice(targetStart, target.end);
      }
      i = target.end;
      continue;
    }

    i += 1;
  }
  return null;
}

/**
 * Look for path-shaped tokens (absolute paths or `~/...`) that resolve
 * outside the allowed roots. Used as a last-resort label when there's no
 * cmdsub, no unsafe binary, and no out-of-roots redirect, but the command
 * still got denied — usually because it's reading/writing somewhere we
 * don't accept (e.g., bare `git push` outside memory dir).
 */
function hasPathOutsideRoots(
  input: string,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (allowedRoots.length === 0) return false;
  const stripped = stripHeredocBodies(input);
  // Look for absolute-path-shaped tokens in the command outside quotes.
  // This is a heuristic — we only flag when at least one absolute path
  // appears that is not inside roots and there's no relative-only
  // alternative reading.
  const tokens = stripped.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) ?? [];
  let sawOutside = false;
  let sawAny = false;
  for (const raw of tokens) {
    const unquoted = stripQuotes(raw);
    if (!unquoted.startsWith("/") && !unquoted.startsWith("~")) continue;
    // Skip standard non-filesystem targets like /dev/null and /dev/std*.
    if (unquoted === "/dev/null" || unquoted.startsWith("/dev/std")) continue;
    sawAny = true;
    const expanded = expandSimpleEnv(unquoted, env);
    if (!isPathInsideRoots(expanded, allowedRoots)) {
      sawOutside = true;
    }
  }
  return sawAny && sawOutside;
}

function readToken(
  input: string,
  start: number,
): { value: string; end: number } | null {
  if (start >= input.length) return null;
  const first = input[start];
  if (first === '"' || first === "'") {
    const close = input.indexOf(first, start + 1);
    if (close === -1) return null;
    return { value: input.slice(start + 1, close), end: close + 1 };
  }
  let end = start;
  while (end < input.length && !/[\s;|&><()`]/.test(input[end] ?? "")) {
    end += 1;
  }
  if (end === start) return null;
  return { value: input.slice(start, end), end };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Expand only `$VAR`, `${VAR}`, and `~` against `env`. Anything else is left
 * literal. Sufficient for the classifier — false negatives just downgrade
 * to the generic reason.
 */
function expandSimpleEnv(value: string, env: NodeJS.ProcessEnv): string {
  let result = value;
  if (result.startsWith("~")) {
    const home = env.HOME ?? "";
    if (home) {
      result = home + result.slice(1);
    }
  }
  result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
    typeof env[name] === "string" ? (env[name] as string) : "",
  );
  result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) =>
    typeof env[name] === "string" ? (env[name] as string) : "",
  );
  return result;
}

function isPathInsideRoots(path: string, roots: string[]): boolean {
  if (!path.startsWith("/")) return true; // unresolvable; don't flag
  for (const root of roots) {
    if (path === root) return true;
    if (path.startsWith(root.endsWith("/") ? root : `${root}/`)) return true;
  }
  return false;
}

/**
 * Remove heredoc bodies from a command string so subsequent scanners don't
 * scan file contents (which legitimately contain `$()`, paths, etc.).
 * Approximate: matches `<<` or `<<-` followed by an optional quote,
 * delimiter, and a body terminated by the delimiter on its own line.
 */
function stripHeredocBodies(input: string): string {
  const lines = input.split(/\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    out.push(line);
    const heredocMatch = line.match(/<<-?\s*("[^"]+"|'[^']+'|[A-Za-z_]\w*)/);
    if (heredocMatch?.[1]) {
      const delim = stripQuotes(heredocMatch[1]);
      i += 1;
      while (i < lines.length && (lines[i] ?? "").trim() !== delim) {
        i += 1;
      }
      if (i < lines.length) {
        out.push(lines[i] ?? "");
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("\n");
}

/**
 * Split a command into segments on `;`, `&&`, `||`, `|`, and newlines,
 * respecting quote regions and heredoc bodies. Used by `findUnsafeBinary`
 * to identify the leading verb of each segment.
 */
function splitSegmentsForClassifier(input: string): string[] {
  const stripped = stripHeredocBodies(input);
  const segments: string[] = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (!ch) {
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < stripped.length && !inSingle) {
      current += stripped.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (stripped.startsWith("&&", i) || stripped.startsWith("||", i)) {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
        segments.push(current);
        current = "";
        i += 1;
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}
