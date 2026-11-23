import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import { Box } from "ink";
import { memo } from "react";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { colors } from "./colors";
import {
  CORE_GRAMMARS,
  configureSyntaxLanguages,
  ensureLanguageLoaded,
} from "./syntax-languages";
import { Text } from "./Text";

let shikiHighlighter: ReturnType<typeof createHighlighterCoreSync> | null =
  null;

function getShikiHighlighter(): ReturnType<typeof createHighlighterCoreSync> {
  if (shikiHighlighter === null) {
    shikiHighlighter = createHighlighterCoreSync({
      themes: [catppuccinMocha, catppuccinLatte],
      langs: CORE_GRAMMARS,
      engine: createJavaScriptRegexEngine(),
    });
    configureSyntaxLanguages({
      registerGrammar: (grammar) => shikiHighlighter?.loadLanguageSync(grammar),
    });
  }
  return shikiHighlighter;
}
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

export type StyledSpan = { text: string; color: string };

export type ClippedSpans = {
  spans: StyledSpan[];
  clipped: boolean;
};

export function clipStyledSpans(
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

export function languageFromPath(filePath: string): string | undefined {
  const basename = filePath.split("/").pop() ?? filePath;
  const lower = basename.toLowerCase();
  if (lower === "makefile") return "makefile";
  if (lower === "dockerfile") return "dockerfile";
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const ext = basename.slice(dotIdx + 1).toLowerCase();
  return Object.hasOwn(EXT_TO_LANG, ext) ? EXT_TO_LANG[ext] : undefined;
}

const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?\s*$/;
const REDIRECT_FILE_RE = />>?\s+(\S+)/;

export function highlightCommand(command: string): StyledSpan[][] {
  const allLines = command.split("\n");
  const firstLine = allLines[0] ?? "";
  const heredocMatch = HEREDOC_RE.exec(firstLine);

  if (heredocMatch && allLines.length > 2) {
    const marker = heredocMatch[1] ?? "EOF";
    let endIdx = allLines.length - 1;
    for (let i = allLines.length - 1; i > 0; i--) {
      if (allLines[i]?.trim() === marker) {
        endIdx = i;
        break;
      }
    }

    const bodyLines = allLines.slice(1, endIdx);
    const terminatorLine = allLines[endIdx] ?? marker;

    const bashSpans = highlightSingleLineBash(firstLine);

    const fileMatch = REDIRECT_FILE_RE.exec(
      firstLine.slice(0, heredocMatch.index),
    );
    const targetFile = fileMatch?.[1];
    const lang = targetFile ? languageFromPath(targetFile) : undefined;

    let bodySpanLines: StyledSpan[][];
    if (lang) {
      bodySpanLines =
        highlightCode(bodyLines.join("\n"), lang) ??
        bodyLines.map((l) => [{ text: l, color: colors.shellSyntax.text }]);
    } else {
      bodySpanLines = bodyLines.map((l) => [
        { text: l, color: colors.shellSyntax.text },
      ]);
    }

    const termSpans = highlightSingleLineBash(terminatorLine);

    return [bashSpans, ...bodySpanLines, termSpans];
  }

  return highlightFullBash(command);
}

function highlightSingleLineBash(line: string): StyledSpan[] {
  return (
    highlightCode(line, BASH_LANGUAGE)?.[0] ?? [
      { text: line, color: colors.shellSyntax.text },
    ]
  );
}

function highlightFullBash(command: string): StyledSpan[][] {
  return (
    highlightCode(command, BASH_LANGUAGE) ??
    command
      .split("\n")
      .map((line) => [{ text: line, color: colors.shellSyntax.text }])
  );
}

export function highlightCode(
  code: string,
  language: string,
): StyledSpan[][] | undefined {
  try {
    const highlighter = getShikiHighlighter();
    if (!ensureLanguageLoaded(language)) return undefined;
    const result = highlighter.codeToTokens(code, {
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
    const highlightedLines = highlightCommand(command);

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
                    <Text color={colors.shellSyntax.prompt}>
                      {FIRST_LINE_PROMPT}
                    </Text>
                  ) : null}
                </Box>
              ) : null}
              <Text color={colors.shellSyntax.text}>
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
