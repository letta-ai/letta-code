import type { ElementContent, RootContent } from "hast";
import { Box } from "ink";
import { common, createLowlight } from "lowlight";
import { memo } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const lowlight = createLowlight(common);
const BASH_LANGUAGE = "bash";
const FIRST_LINE_PREFIX = "$ ";

type Props = {
  command: string;
  showPrompt?: boolean;
  prefix?: string;
  suffix?: string;
};

type ShellSyntaxPalette = typeof colors.shellSyntax;

/** Styled text span with a resolved color. */
export type StyledSpan = { text: string; color: string };

/** Map file extension to a lowlight language name. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  php: "php",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  mdx: "markdown",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  makefile: "makefile",
  dockerfile: "dockerfile",
  r: "r",
  lua: "lua",
  perl: "perl",
  pl: "perl",
  diff: "diff",
  graphql: "graphql",
  gql: "graphql",
  wasm: "wasm",
};

/** Resolve a lowlight language name from a file path, or undefined if unknown. */
export function languageFromPath(filePath: string): string | undefined {
  const basename = filePath.split("/").pop() ?? filePath;
  const lower = basename.toLowerCase();
  // Handle dotfiles like "Makefile", "Dockerfile"
  if (lower === "makefile") return "makefile";
  if (lower === "dockerfile") return "dockerfile";
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const ext = basename.slice(dotIdx + 1).toLowerCase();
  return EXT_TO_LANG[ext];
}

function colorForClassName(
  className: string,
  palette: ShellSyntaxPalette,
): string {
  if (className === "hljs-comment") return palette.comment;
  if (className === "hljs-keyword") return palette.keyword;
  if (className === "hljs-string" || className === "hljs-regexp") {
    return palette.string;
  }
  if (className === "hljs-number") return palette.number;
  if (className === "hljs-literal") return palette.literal;
  if (
    className === "hljs-built_in" ||
    className === "hljs-builtin-name" ||
    className === "hljs-type"
  ) {
    return palette.builtIn;
  }
  if (
    className === "hljs-variable" ||
    className === "hljs-template-variable" ||
    className === "hljs-params"
  ) {
    return palette.variable;
  }
  if (className === "hljs-title" || className === "hljs-function") {
    return palette.title;
  }
  if (className === "hljs-attr" || className === "hljs-attribute") {
    return palette.attr;
  }
  if (className === "hljs-meta") return palette.meta;
  if (
    className === "hljs-operator" ||
    className === "hljs-punctuation" ||
    className === "hljs-symbol"
  ) {
    return palette.operator;
  }
  if (className === "hljs-subst") return palette.substitution;
  return palette.text;
}

/**
 * Walk the HAST tree depth-first, collecting flat StyledSpan entries.
 * Newlines within text nodes are preserved so callers can split into lines.
 */
export function collectSpans(
  node: RootContent | ElementContent,
  palette: ShellSyntaxPalette,
  spans: StyledSpan[],
  inheritedColor?: string,
): void {
  if (node.type === "text") {
    spans.push({ text: node.value, color: inheritedColor ?? palette.text });
    return;
  }

  if (node.type === "element") {
    const nodeClasses =
      (node.properties?.className as string[] | undefined) ?? [];
    const highlightClass = [...nodeClasses]
      .reverse()
      .find((name) => name.startsWith("hljs-"));
    const nodeColor = highlightClass
      ? colorForClassName(highlightClass, palette)
      : inheritedColor;

    for (const child of node.children) {
      collectSpans(child, palette, spans, nodeColor);
    }
  }
}

// Detect heredoc: first line ends with << 'MARKER', << "MARKER", or << MARKER.
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?\s*$/;
// Extract redirect target filename: > filepath or >> filepath before the <<.
const REDIRECT_FILE_RE = />>?\s+(\S+)/;

/**
 * Highlight a bash command, with special handling for heredocs.
 * When a heredoc is detected, the body is highlighted using the language
 * inferred from the redirect target filename (e.g. .ts -> typescript).
 */
function highlightCommand(
  command: string,
  palette: ShellSyntaxPalette,
): StyledSpan[][] {
  const allLines = command.split("\n");
  const firstLine = allLines[0] ?? "";
  const heredocMatch = HEREDOC_RE.exec(firstLine);

  // If heredoc detected and there's body content, split highlighting.
  if (heredocMatch && allLines.length > 2) {
    const marker = heredocMatch[1] ?? "EOF";
    // Find where the heredoc body ends (the marker terminator line).
    let endIdx = allLines.length - 1;
    for (let i = allLines.length - 1; i > 0; i--) {
      if (allLines[i]?.trim() === marker) {
        endIdx = i;
        break;
      }
    }

    const bodyLines = allLines.slice(1, endIdx);
    const terminatorLine = allLines[endIdx] ?? marker;

    // Highlight the first line as bash.
    const bashSpans = highlightSingleLineBash(firstLine, palette);

    // Determine language from redirect target filename.
    const fileMatch = REDIRECT_FILE_RE.exec(
      firstLine.slice(0, heredocMatch.index),
    );
    const targetFile = fileMatch?.[1];
    const lang = targetFile ? languageFromPath(targetFile) : undefined;

    // Highlight heredoc body with target language.
    let bodySpanLines: StyledSpan[][];
    if (lang) {
      bodySpanLines =
        highlightCode(bodyLines.join("\n"), lang) ??
        bodyLines.map((l) => [{ text: l, color: palette.text }]);
    } else {
      bodySpanLines = bodyLines.map((l) => [{ text: l, color: palette.text }]);
    }

    // Highlight terminator as bash.
    const termSpans = highlightSingleLineBash(terminatorLine, palette);

    return [bashSpans, ...bodySpanLines, termSpans];
  }

  // No heredoc: highlight full command as bash.
  return highlightFullBash(command, palette);
}

/** Highlight a single line as bash, returning a flat StyledSpan array. */
function highlightSingleLineBash(
  line: string,
  palette: ShellSyntaxPalette,
): StyledSpan[] {
  try {
    const root = lowlight.highlight(BASH_LANGUAGE, line);
    const spans: StyledSpan[] = [];
    for (const child of root.children) {
      collectSpans(child, palette, spans);
    }
    return spans;
  } catch {
    return [{ text: line, color: palette.text }];
  }
}

/** Highlight full multi-line text as bash, split at newline boundaries. */
function highlightFullBash(
  command: string,
  palette: ShellSyntaxPalette,
): StyledSpan[][] {
  let spans: StyledSpan[];
  try {
    const root = lowlight.highlight(BASH_LANGUAGE, command);
    spans = [];
    for (const child of root.children) {
      collectSpans(child, palette, spans);
    }
  } catch {
    return command
      .split("\n")
      .map((line) => [{ text: line, color: palette.text }]);
  }

  const lines: StyledSpan[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
      }
      const part = parts[i];
      if (part && part.length > 0) {
        const currentLine = lines[lines.length - 1];
        currentLine?.push({ text: part, color: span.color });
      }
    }
  }
  return lines;
}

/**
 * Highlight code in any language, returning per-line StyledSpan arrays.
 * Highlights the full text at once to preserve multi-line parser state,
 * then splits at newline boundaries.
 * Returns undefined when the language is not recognized.
 */
export function highlightCode(
  code: string,
  language: string,
): StyledSpan[][] | undefined {
  const palette = colors.shellSyntax;
  let spans: StyledSpan[];
  try {
    const root = lowlight.highlight(language, code);
    spans = [];
    for (const child of root.children) {
      collectSpans(child, palette, spans);
    }
  } catch {
    return undefined;
  }

  const lines: StyledSpan[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
      }
      const part = parts[i];
      if (part && part.length > 0) {
        const currentLine = lines[lines.length - 1];
        currentLine?.push({ text: part, color: span.color });
      }
    }
  }
  return lines;
}

export const SyntaxHighlightedCommand = memo(
  ({ command, showPrompt = true, prefix, suffix }: Props) => {
    const palette = colors.shellSyntax;
    const lines = highlightCommand(command, palette);

    return (
      <Box flexDirection="column">
        {lines.map((spans, lineIdx) => {
          const lineKey = spans.map((s) => s.text).join("");
          return (
            <Box key={`${lineIdx}:${lineKey}`}>
              {showPrompt ? (
                <Text color={palette.prompt}>
                  {lineIdx === 0 ? FIRST_LINE_PREFIX : "  "}
                </Text>
              ) : null}
              <Text color={palette.text}>
                {lineIdx === 0 && prefix ? prefix : null}
                {spans.map((span, si) => (
                  <Text key={`${si}:${span.color}`} color={span.color}>
                    {span.text}
                  </Text>
                ))}
                {lineIdx === lines.length - 1 && suffix ? suffix : null}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  },
);

SyntaxHighlightedCommand.displayName = "SyntaxHighlightedCommand";
