import { createRequire } from "node:module";
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

const CORE_LANG_NAMES = new Set(
  CORE_GRAMMARS.flatMap((grammar) => [
    grammar.name,
    ...(grammar.aliases ?? []),
  ]),
);

type GrammarModule = { default: LanguageRegistration | LanguageRegistration[] };

const requireGrammar = createRequire(import.meta.url);

const TAIL_LOADERS: Record<string, () => GrammarModule> = {
  c: () => requireGrammar("@shikijs/langs/c"),
  cpp: () => requireGrammar("@shikijs/langs/cpp"),
  "c++": () => requireGrammar("@shikijs/langs/cpp"),
  csharp: () => requireGrammar("@shikijs/langs/csharp"),
  "c#": () => requireGrammar("@shikijs/langs/csharp"),
  css: () => requireGrammar("@shikijs/langs/css"),
  docker: () => requireGrammar("@shikijs/langs/docker"),
  dockerfile: () => requireGrammar("@shikijs/langs/docker"),
  go: () => requireGrammar("@shikijs/langs/go"),
  graphql: () => requireGrammar("@shikijs/langs/graphql"),
  html: () => requireGrammar("@shikijs/langs/html"),
  ini: () => requireGrammar("@shikijs/langs/ini"),
  java: () => requireGrammar("@shikijs/langs/java"),
  kotlin: () => requireGrammar("@shikijs/langs/kotlin"),
  kts: () => requireGrammar("@shikijs/langs/kotlin"),
  less: () => requireGrammar("@shikijs/langs/less"),
  lua: () => requireGrammar("@shikijs/langs/lua"),
  make: () => requireGrammar("@shikijs/langs/make"),
  makefile: () => requireGrammar("@shikijs/langs/make"),
  perl: () => requireGrammar("@shikijs/langs/perl"),
  php: () => requireGrammar("@shikijs/langs/php"),
  r: () => requireGrammar("@shikijs/langs/r"),
  ruby: () => requireGrammar("@shikijs/langs/ruby"),
  rust: () => requireGrammar("@shikijs/langs/rust"),
  scala: () => requireGrammar("@shikijs/langs/scala"),
  scss: () => requireGrammar("@shikijs/langs/scss"),
  sql: () => requireGrammar("@shikijs/langs/sql"),
  swift: () => requireGrammar("@shikijs/langs/swift"),
  toml: () => requireGrammar("@shikijs/langs/toml"),
  wasm: () => requireGrammar("@shikijs/langs/wasm"),
};

const TAIL_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  kts: "kotlin",
};

const loadedTail = new Set<string>();
const unavailable = new Set<string>();

let registerGrammar: ((grammar: LanguageRegistration) => void) | null = null;

export function configureSyntaxLanguages(hooks: {
  registerGrammar: (grammar: LanguageRegistration) => void;
}): void {
  registerGrammar = hooks.registerGrammar;
}

export function ensureLanguageLoaded(language: string): boolean {
  const lang = language.toLowerCase();
  if (CORE_LANG_NAMES.has(lang) || loadedTail.has(lang)) return true;
  if (unavailable.has(lang)) return false;
  const loaderKey = Object.hasOwn(TAIL_LOADERS, lang)
    ? lang
    : Object.hasOwn(TAIL_ALIASES, lang)
      ? TAIL_ALIASES[lang]
      : undefined;
  const loader = loaderKey !== undefined ? TAIL_LOADERS[loaderKey] : undefined;
  if (!loader) {
    unavailable.add(lang);
    return false;
  }
  try {
    const mod = loader();
    const registrations = Array.isArray(mod.default)
      ? mod.default
      : [mod.default];
    for (const registration of registrations) {
      registerGrammar?.(registration);
      for (const name of [registration.name, ...(registration.aliases ?? [])]) {
        loadedTail.add(name);
      }
    }
    return true;
  } catch {
    unavailable.add(lang);
    return false;
  }
}
