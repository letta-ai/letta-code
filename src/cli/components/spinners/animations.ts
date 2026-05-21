/**
 * Braille spinner animations available to {@link StreamingStatusSpinner}.
 *
 * Frames are pre-computed from the procedural generators in
 * `gunnargray-dev/unicode-animations`. Each entry below renders as a
 * single braille character (1 terminal cell) so animations can be swapped
 * without disturbing surrounding layout — keep new entries to a 2x4 dot
 * grid (W=2 in the upstream generator) for the same width guarantee.
 *
 * To add a new animation:
 *   1. Define a {@link BrailleAnimation} entry below.
 *   2. Append its key to {@link STREAMING_STATUS_ANIMATION_KEYS}.
 */

export type BrailleAnimation = {
  readonly frames: readonly string[];
  readonly intervalMs: number;
};

/** 2-dot "comet" rotating clockwise around a 2x4 ring. */
const ORBIT: BrailleAnimation = {
  frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"],
  intervalMs: 100,
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
};

export const BRAILLE_ANIMATIONS = {
  orbit: ORBIT,
  breathe: BREATHE,
} as const satisfies Readonly<Record<string, BrailleAnimation>>;

export type BrailleAnimationKey = keyof typeof BRAILLE_ANIMATIONS;

/**
 * Pool that {@link StreamingStatusSpinner} picks from at random on mount.
 * Order is irrelevant — picks are uniform across this list.
 */
export const STREAMING_STATUS_ANIMATION_KEYS: readonly BrailleAnimationKey[] = [
  "orbit",
  "breathe",
];
