/**
 * Braille spinner animations available to {@link StreamingStatusSpinner}.
 *
 * Frames are pre-computed from the procedural generators in
 * `gunnargray-dev/unicode-animations`. The `cellWidth` field is the
 * number of terminal cells each frame occupies (2 dot-columns per cell);
 * the consumer reads this to size its layout slot.
 *
 * To add a new animation:
 *   1. Define a {@link BrailleAnimation} entry below.
 *   2. Add it to {@link BRAILLE_ANIMATIONS}.
 *   3. Optionally include it in {@link STREAMING_STATUS_ANIMATION_KEYS}
 *      (the unconstrained random pool) or in
 *      {@link CONTEXT_TIER_ANIMATIONS} (the context-tier router).
 */

export type BrailleAnimation = {
  readonly frames: readonly string[];
  readonly intervalMs: number;
  readonly cellWidth: number;
};

/** 2-dot "comet" rotating clockwise around a 2x4 ring. */
const ORBIT: BrailleAnimation = {
  frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"],
  intervalMs: 100,
  cellWidth: 1,
};

/** Cell fills from a single dot to all 8, holds, then deflates back. */
const BREATHE: BrailleAnimation = {
  frames: [
    "⠀",
    "⠂",
    "⠌",
    "⡑",
    "⢕",
    "⢝",
    "⣫",
    "⣟",
    "⣿",
    "⣟",
    "⣫",
    "⢝",
    "⢕",
    "⡑",
    "⠌",
    "⠂",
    "⠀",
  ],
  intervalMs: 100,
  cellWidth: 1,
};

/** 4-cell tail traversing a serpentine path through a 4x4 grid. */
const SNAKE: BrailleAnimation = {
  frames: [
    "⣁⡀",
    "⣉⠀",
    "⡉⠁",
    "⠉⠉",
    "⠈⠙",
    "⠀⠛",
    "⠐⠚",
    "⠒⠒",
    "⠖⠂",
    "⠶⠀",
    "⠦⠄",
    "⠤⠤",
    "⠠⢤",
    "⠀⣤",
    "⢀⣠",
    "⣀⣀",
  ],
  intervalMs: 80,
  cellWidth: 2,
};

/** Concentric rings expanding outward from the center of a 6x4 grid. */
const PULSE: BrailleAnimation = {
  frames: ["⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹", "⡁⠀⢈"],
  intervalMs: 180,
  cellWidth: 3,
};

/** Diagonal sweep across an 8x4 grid. */
const CASCADE: BrailleAnimation = {
  frames: [
    "⠀⠀⠀⠀",
    "⠀⠀⠀⠀",
    "⠁⠀⠀⠀",
    "⠋⠀⠀⠀",
    "⠞⠁⠀⠀",
    "⡴⠋⠀⠀",
    "⣠⠞⠁⠀",
    "⢀⡴⠋⠀",
    "⠀⣠⠞⠁",
    "⠀⢀⡴⠋",
    "⠀⠀⣠⠞",
    "⠀⠀⢀⡴",
    "⠀⠀⠀⣠",
    "⠀⠀⠀⢀",
  ],
  intervalMs: 60,
  cellWidth: 4,
};

export const BRAILLE_ANIMATIONS = {
  orbit: ORBIT,
  breathe: BREATHE,
  snake: SNAKE,
  pulse: PULSE,
  cascade: CASCADE,
} as const satisfies Readonly<Record<string, BrailleAnimation>>;

export type BrailleAnimationKey = keyof typeof BRAILLE_ANIMATIONS;

/**
 * Unconstrained random pool used when no tier is specified. Keep this
 * list to 1-cell-wide animations so the spinner is a true drop-in.
 */
export const STREAMING_STATUS_ANIMATION_KEYS: readonly BrailleAnimationKey[] = [
  "orbit",
  "breathe",
];

/**
 * Tier 0 — 0–25% context used. Width 1.
 * Tier 1 — 25–50%. Width 2.
 * Tier 2 — 50–75%. Width 3.
 * Tier 3 — 75–100%. Width 4.
 *
 * Each tier is a pool; the spinner picks one entry at random when the
 * tier becomes active and holds that choice until the tier changes.
 */
export const CONTEXT_TIER_ANIMATIONS: readonly (readonly BrailleAnimationKey[])[] =
  [["orbit", "breathe"], ["snake"], ["pulse"], ["cascade"]];

export const CONTEXT_TIER_COUNT = CONTEXT_TIER_ANIMATIONS.length;

/**
 * Map a context-usage ratio (0..1) to a tier index in
 * {@link CONTEXT_TIER_ANIMATIONS}. Anything outside [0, 1] clamps.
 */
export function contextTierFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 0.75) return 3;
  if (ratio >= 0.5) return 2;
  if (ratio >= 0.25) return 1;
  return 0;
}

/**
 * Cell width reserved for the spinner at a given tier. The consumer
 * uses this to size its layout slot so animations render without
 * truncation.
 */
export function spinnerWidthForTier(tier: number): number {
  const clamped = Math.max(0, Math.min(CONTEXT_TIER_COUNT - 1, tier));
  const pool = CONTEXT_TIER_ANIMATIONS[clamped];
  const firstKey = pool?.[0];
  if (!firstKey) return 1;
  return BRAILLE_ANIMATIONS[firstKey].cellWidth;
}
