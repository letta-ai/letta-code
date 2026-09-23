/**
 * Syntax highlighting language registry for the TUI.
 *
 * Previously every supported TextMate grammar (~35 languages) was statically
 * imported and evaluated at process start, costing ~11 MB of heap and ~28 MB
 * of RSS before any work happened (LET-13149). Now a small core set loads
 * eagerly and the long tail loads on first use: the first highlight request
 * for an unloaded language renders plain, kicks off the grammar import, and a
 * transcript repaint re-renders it highlighted once the grammar registers.
 */

import bashLang from "@shikijs/langs/bash";
import diffLang from "@shikijs/langs/diff";
import javascriptLang from "@shikijs/langs/javascript";
import jsonLang from "@shikijs/langs/json";
import markdownLang from "@shikijs/langs/markdown";
import pythonLang from "@shikijs/langs/python";
import tsxLang from "@shikijs/langs/tsx";
import typescriptLang from "@shikijs/langs/typescript";
import xmlLang from "@shikijs/langs/xml";
import yamlLang from "@shikijs/langs/yaml";
import type { LanguageRegistration } from "@shikijs/types";

/** Grammars evaluated at startup: the languages a coding session hits most. */
const coreGrammarModules = [
  bashLang,
  diffLang,
  javascriptLang,
  jsonLang,
  markdownLang,
  pythonLang,
  tsxLang,
  typescriptLang,
  xmlLang,
  yamlLang,
];
export const CORE_GRAMMARS: LanguageRegistration[] = coreGrammarModules.flatMap(
  (mod) => (Array.isArray(mod) ? mod : [mod]),
) as LanguageRegistration[];

/** Every name the core grammars answer to, including their shiki aliases. */
const CORE_LANG_NAMES = new Set(
  CORE_GRAMMARS.flatMap((grammar) => [
    grammar.name,
    ...(grammar.aliases ?? []),
  ]),
);

type GrammarModule = { default: LanguageRegistration | LanguageRegistration[] };

/** Long-tail grammars, loaded on first highlight of that language. */
const TAIL_LOADERS: Record<string, () => Promise<GrammarModule>> = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  docker: () => import("@shikijs/langs/docker"),
  dockerfile: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  makefile: () => import("@shikijs/langs/make"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  wasm: () => import("@shikijs/langs/wasm"),
};

const loadedTail = new Set<string>();
const inFlight = new Set<string>();
const unavailable = new Set<string>();

/** Called once by the highlighter owner so tail loads can register grammars. */
let registerGrammar: ((grammar: LanguageRegistration) => void) | null = null;
/** Called after a tail grammar registers so committed output re-renders. */
let onTailLanguageLoaded: (() => void) | null = null;

export function configureSyntaxLanguages(hooks: {
  registerGrammar: (grammar: LanguageRegistration) => void;
  onTailLanguageLoaded: () => void;
}): void {
  registerGrammar = hooks.registerGrammar;
  onTailLanguageLoaded = hooks.onTailLanguageLoaded;
}

/**
 * Returns true when the language is ready for synchronous highlighting.
 * Otherwise kicks off its grammar load once and returns false so the caller
 * renders plain text until the transcript repaint after registration.
 */
export function ensureLanguageLoaded(language: string): boolean {
  const lang = language.toLowerCase();
  if (CORE_LANG_NAMES.has(lang) || loadedTail.has(lang)) return true;
  if (unavailable.has(lang) || inFlight.has(lang)) return false;
  const loader = TAIL_LOADERS[lang];
  if (!loader) {
    unavailable.add(lang);
    return false;
  }
  inFlight.add(lang);
  loader()
    .then((mod) => {
      inFlight.delete(lang);
      const registrations = Array.isArray(mod.default)
        ? mod.default
        : [mod.default];
      for (const registration of registrations) {
        registerGrammar?.(registration);
        for (const name of [
          registration.name,
          ...(registration.aliases ?? []),
        ]) {
          loadedTail.add(name);
        }
      }
      onTailLanguageLoaded?.();
    })
    .catch(() => {
      inFlight.delete(lang);
      unavailable.add(lang);
    });
  return false;
}
