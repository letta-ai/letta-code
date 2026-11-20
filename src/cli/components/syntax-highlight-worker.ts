import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  CORE_GRAMMARS,
  configureSyntaxLanguages,
  ensureLanguageLoaded,
} from "./syntax-languages";

export type StyledSpan = { text: string; color: string };

export type HighlightRequest = {
  code: string;
  language: string;
  theme: "catppuccin-latte" | "catppuccin-mocha";
  color: string;
  signal: Int32Array<SharedArrayBuffer>;
};

const port = workerData as MessagePort;
const highlighter = createHighlighterCoreSync({
  themes: [catppuccinMocha, catppuccinLatte],
  langs: CORE_GRAMMARS,
  engine: createJavaScriptRegexEngine(),
});
configureSyntaxLanguages({
  registerGrammar: (grammar) => highlighter.loadLanguageSync(grammar),
});

parentPort?.on("message", (request: HighlightRequest) => {
  let lines: StyledSpan[][] | undefined;
  try {
    if (ensureLanguageLoaded(request.language)) {
      const result = highlighter.codeToTokens(request.code, {
        lang: request.language,
        theme: request.theme,
      });
      lines = result.tokens.map((line) =>
        line.map((token) => ({
          text: token.content,
          color: token.color ?? request.color,
        })),
      );
    }
  } catch {
    // Preserve the caller's plain-text fallback for unsupported grammars.
  }
  port.postMessage(lines);
  Atomics.store(request.signal, 0, 1);
  Atomics.notify(request.signal, 0);
});
