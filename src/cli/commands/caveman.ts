export const CAVEMAN_MODE_HINT =
  "[lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra]";

export const CAVEMAN_MODES = [
  "lite",
  "full",
  "ultra",
  "wenyan-lite",
  "wenyan-full",
  "wenyan-ultra",
] as const;

export type CavemanMode = (typeof CAVEMAN_MODES)[number];

const CAVEMAN_COMMAND_PATTERN = /^\/caveman(?:\s|$)/;

const CAVEMAN_MODE_ALIASES: Record<string, CavemanMode> = {
  "": "full",
  lite: "lite",
  full: "full",
  ultra: "ultra",
  ulta: "ultra",
  wenyan: "wenyan-full",
  "wenyan-lite": "wenyan-lite",
  "wenyan-full": "wenyan-full",
  "wenyan-ultra": "wenyan-ultra",
  "wenyan-ulta": "wenyan-ultra",
};

// Keep these mode rules aligned with persona_caveman.mdx and builtin/caveman/SKILL.md.
export const CAVEMAN_MODE_RULES: Record<CavemanMode, string[]> = {
  lite: [
    "Mode rules: remove filler, pleasantries, and hedging, but keep articles and complete professional sentences.",
    "Example style: Component re-renders because object reference changes each render. Wrap it in `useMemo`.",
  ],
  full: [
    "Mode rules: drop articles, fragments are okay, use short synonyms, and keep classic cave-code compression.",
    "Example style: New object ref each render. Inline prop = new ref = re-render. Wrap in `useMemo`.",
  ],
  ultra: [
    "Mode rules: abbreviate common technical nouns, strip conjunctions, use arrows for causality, and use one word when enough.",
    "Example style: Inline obj prop → new ref → re-render. `useMemo`.",
  ],
  "wenyan-lite": [
    "Mode rules: use semi-classical Chinese register, drop filler and hedging, but keep readable grammar structure.",
    "Example style: 組件頻重繪，以每繪新生對象參照故。以 `useMemo` 包之。",
  ],
  "wenyan-full": [
    "Mode rules: write compact 文言文: major character reduction, subject omission, verb-object terseness, particles like 之/乃/為/其.",
    "Example style: 物出新參照，致重繪。`useMemo` 包之。",
  ],
  "wenyan-ultra": [
    "Mode rules: extreme compact 文言 style, maximum compression, arrows allowed when they clarify cause.",
    "Example style: 新參照→重繪。`useMemo`。",
  ],
};

export function isCavemanCommandInput(input: string): boolean {
  return CAVEMAN_COMMAND_PATTERN.test(input);
}

export function normalizeCavemanMode(input: string): CavemanMode | null {
  const normalized = input.trim().toLowerCase();
  return CAVEMAN_MODE_ALIASES[normalized] ?? null;
}

export function buildCavemanCommandPrompt(mode: CavemanMode): string {
  return [
    `Switch to cave-code ${mode} mode.`,
    ...CAVEMAN_MODE_RULES[mode],
    "Apply this mode for this conversation only. Do not call any tools for this mode switch.",
    "Reasoning fire stays on: every reasoning_message must be non-empty cave-grunt, never analyst prose.",
    'No analyst layer: no "The user is asking", no "Let me think", no "I should", no prompt/tool bookkeeping.',
    "Hidden reasoning, plans, and visible replies all follow the selected cave-code mode.",
    "Technical terms stay exact. Code and quoted errors stay unchanged.",
    "If safety-critical, destructive, or easy to misunderstand, switch to clear normal language for that part, then return to cave-code.",
  ].join("\n");
}
