import bashLang from "@shikijs/langs/bash";
import cLang from "@shikijs/langs/c";
import cppLang from "@shikijs/langs/cpp";
import csharpLang from "@shikijs/langs/csharp";
import cssLang from "@shikijs/langs/css";
import diffLang from "@shikijs/langs/diff";
import dockerLang from "@shikijs/langs/docker";
import goLang from "@shikijs/langs/go";
import graphqlLang from "@shikijs/langs/graphql";
import htmlLang from "@shikijs/langs/html";
import iniLang from "@shikijs/langs/ini";
import javaLang from "@shikijs/langs/java";
import javascriptLang from "@shikijs/langs/javascript";
import jsonLang from "@shikijs/langs/json";
import kotlinLang from "@shikijs/langs/kotlin";
import lessLang from "@shikijs/langs/less";
import luaLang from "@shikijs/langs/lua";
import makeLang from "@shikijs/langs/make";
import markdownLang from "@shikijs/langs/markdown";
import perlLang from "@shikijs/langs/perl";
import phpLang from "@shikijs/langs/php";
import pythonLang from "@shikijs/langs/python";
import rLang from "@shikijs/langs/r";
import rubyLang from "@shikijs/langs/ruby";
import rustLang from "@shikijs/langs/rust";
import scalaLang from "@shikijs/langs/scala";
import scssLang from "@shikijs/langs/scss";
import sqlLang from "@shikijs/langs/sql";
import swiftLang from "@shikijs/langs/swift";
import tomlLang from "@shikijs/langs/toml";
import tsxLang from "@shikijs/langs/tsx";
import typescriptLang from "@shikijs/langs/typescript";
import wasmLang from "@shikijs/langs/wasm";
import xmlLang from "@shikijs/langs/xml";
import yamlLang from "@shikijs/langs/yaml";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import type { ElementContent, RootContent } from "hast";
import { Box } from "ink";
import { common, createLowlight } from "lowlight";
import { memo } from "react";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { colors } from "./colors";
import { Text } from "./Text";

const lowlight = createLowlight(common);
const shikiHighlighter = createHighlighterCoreSync({
  themes: [catppuccinMocha, catppuccinLatte],
  langs: [
    bashLang,
    cLang,
    cppLang,
    csharpLang,
    cssLang,
    diffLang,
    dockerLang,
    goLang,
    graphqlLang,
    htmlLang,
    iniLang,
    javaLang,
    javascriptLang,
    jsonLang,
    kotlinLang,
    lessLang,
    luaLang,
    makeLang,
    markdownLang,
    perlLang,
    phpLang,
    pythonLang,
    rLang,
    rubyLang,
    rustLang,
    scalaLang,
    scssLang,
    sqlLang,
    swiftLang,
    tomlLang,
    tsxLang,
    typescriptLang,
    wasmLang,
    xmlLang,
    yamlLang,
  ],
  engine: createJavaScriptRegexEngine(),
});
const BASH_LANGUAGE = "bash";
const FIRST_LINE_PROMPT = "$";
const PROMPT_COLUMN_WIDTH = 2;

type Props = {
  command: string;
  showPrompt?: boolean;
  prefix?: string;
  suffix?: string;
  maxLines?: number;
  maxColumns?: number;
  showTruncationHint?: boolean;
};

type ShellSyntaxPalette = typeof colors.shellSyntax;

/** Styled text span with a resolved color. */
export type StyledSpan = { text: string; color: string };

type ClippedSpans = {
  spans: StyledSpan[];
  clipped: boolean;
};

function clipStyledSpans(
  spans: StyledSpan[],
  maxColumns: number,
): ClippedSpans {
  if (maxColumns <= 0) {
    return { spans: [], clipped: spans.length > 0 };
  }

  let remaining = maxColumns;
  const clipped: StyledSpan[] = [];

  for (const span of spans) {
    if (remaining <= 0) {
      return { spans: clipped, clipped: true };
    }
    if (span.text.length <= remaining) {
      clipped.push(span);
      remaining -= span.text.length;
      continue;
    }

    clipped.push({ text: span.text.slice(0, remaining), color: span.color });
    return { spans: clipped, clipped: true };
  }

  return { spans: clipped, clipped: false };
}

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
  try {
    const result = shikiHighlighter.codeToTokens(code, {
      lang: language,
      theme:
        colors.shellSyntax === colors.shellSyntaxLight
          ? "catppuccin-latte"
          : "catppuccin-mocha",
    });
    return result.tokens.map((line) =>
      line.map((token) => ({
        text: token.content,
        color: token.color ?? colors.shellSyntax.text,
      })),
    );
  } catch {
    return undefined;
  }
}

export const SyntaxHighlightedCommand = memo(
  ({
    command,
    showPrompt = true,
    prefix,
    suffix,
    maxLines,
    maxColumns,
    showTruncationHint = false,
  }: Props) => {
    const palette = colors.shellSyntax;
    const highlightedLines = highlightCommand(command, palette);

    const hasLineCap = typeof maxLines === "number" && maxLines >= 0;
    const visibleLines = hasLineCap
      ? highlightedLines.slice(0, maxLines)
      : highlightedLines;
    const hiddenLineCount = Math.max(
      0,
      highlightedLines.length - visibleLines.length,
    );

    const renderedLines: StyledSpan[][] = [];
    let anyColumnClipping = false;
    for (let i = 0; i < visibleLines.length; i++) {
      const spans = visibleLines[i] ?? [];
      if (typeof maxColumns === "number") {
        const prefixLen = i === 0 && prefix ? prefix.length : 0;
        const suffixLen =
          i === visibleLines.length - 1 && suffix ? suffix.length : 0;
        const textBudget = Math.max(0, maxColumns - prefixLen - suffixLen);
        const clipped = clipStyledSpans(spans, textBudget);
        renderedLines.push(clipped.spans);
        anyColumnClipping = anyColumnClipping || clipped.clipped;
      } else {
        renderedLines.push(spans);
      }
    }

    return (
      <Box flexDirection="column">
        {renderedLines.map((spans, lineIdx) => {
          const lineKey = spans.map((s) => s.text).join("");
          return (
            <Box key={`${lineIdx}:${lineKey}`}>
              {showPrompt ? (
                <Box width={PROMPT_COLUMN_WIDTH} flexShrink={0}>
                  {lineIdx === 0 ? (
                    <Text color={palette.prompt}>{FIRST_LINE_PROMPT}</Text>
                  ) : null}
                </Box>
              ) : null}
              <Text color={palette.text}>
                {lineIdx === 0 && prefix ? prefix : null}
                {spans.map((span, si) => (
                  <Text key={`${si}:${span.color}`} color={span.color}>
                    {span.text}
                  </Text>
                ))}
                {lineIdx === renderedLines.length - 1 && suffix ? suffix : null}
              </Text>
            </Box>
          );
        })}
        {showTruncationHint && hiddenLineCount > 0 && (
          <Text dimColor>{`… +${hiddenLineCount} more lines`}</Text>
        )}
        {showTruncationHint && hiddenLineCount === 0 && anyColumnClipping && (
          <Text dimColor>… output clipped</Text>
        )}
      </Box>
    );
  },
);

SyntaxHighlightedCommand.displayName = "SyntaxHighlightedCommand";
