export type BrailleAnimation = {
  readonly frames: readonly string[];
  readonly intervalMs: number;
  readonly cellWidth: number;
};

const ORBIT: BrailleAnimation = {
  frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"],
  intervalMs: 100,
  cellWidth: 1,
};

const BREATHE: BrailleAnimation = {
  frames: [
    "⠀",
    "⠂",
    "⠢",
    "⠲",
    "⠶",
    "⠷",
    "⢷",
    "⢿",
    "⣿",
    "⢿",
    "⢷",
    "⠷",
    "⠶",
    "⠲",
    "⠢",
    "⠂",
    "⠀",
  ],
  intervalMs: 100,
  cellWidth: 1,
};

const SNAKE: BrailleAnimation = {
  frames: [
    "⡇⠀",
    "⠏⠀",
    "⠋⠁",
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
    "⣄⡀",
    "⣆⠀",
    "⡇⠀",
    "⠏⠀",
    "⠛⠀",
    "⠹⠀",
    "⢸⠀",
    "⢰⡀",
    "⢠⡄",
    "⢀⡆",
    "⠀⡇",
    "⠀⠏",
    "⠀⠛",
    "⠀⠹",
    "⠀⢸",
    "⠀⣰",
    "⢀⣠",
    "⣀⣀",
    "⣄⡀",
    "⣤⠀",
    "⡤⠄",
    "⠤⠤",
    "⠠⠴",
    "⠀⠶",
    "⠐⠲",
    "⠒⠒",
    "⠓⠂",
    "⠛⠀",
    "⠋⠁",
    "⠉⠉",
    "⠈⠙",
    "⠀⠹",
    "⠀⢸",
    "⠀⣰",
    "⠀⣤",
    "⠀⣆",
    "⠀⡇",
    "⠈⠇",
    "⠘⠃",
    "⠸⠁",
    "⢸⠀",
    "⣰⠀",
    "⣤⠀",
    "⣆⠀",
  ],
  intervalMs: 80,
  cellWidth: 2,
};

const PULSE: BrailleAnimation = {
  frames: ["⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹", "⡁⠀⢈"],
  intervalMs: 180,
  cellWidth: 3,
};

const SAND: BrailleAnimation = {
  frames: [
    "⠁",
    "⠂",
    "⠄",
    "⡀",
    "⡈",
    "⡐",
    "⡠",
    "⣀",
    "⣁",
    "⣂",
    "⣄",
    "⣌",
    "⣔",
    "⣤",
    "⣥",
    "⣦",
    "⣮",
    "⣶",
    "⣷",
    "⣿",
    "⡿",
    "⠿",
    "⢟",
    "⠟",
    "⡛",
    "⠛",
    "⠫",
    "⢋",
    "⠋",
    "⠍",
    "⡉",
    "⠉",
    "⠑",
    "⠡",
    "⢁",
  ],
  intervalMs: 80,
  cellWidth: 1,
};

const DOTS12: BrailleAnimation = {
  frames: [
    "⢀⠀",
    "⡀⠀",
    "⠄⠀",
    "⢂⠀",
    "⡂⠀",
    "⠅⠀",
    "⢃⠀",
    "⡃⠀",
    "⠍⠀",
    "⢋⠀",
    "⡋⠀",
    "⠍⠁",
    "⢋⠁",
    "⡋⠁",
    "⠍⠉",
    "⠋⠉",
    "⠋⠉",
    "⠉⠙",
    "⠉⠙",
    "⠉⠩",
    "⠈⢙",
    "⠈⡙",
    "⢈⠩",
    "⡀⢙",
    "⠄⡙",
    "⢂⠩",
    "⡂⢘",
    "⠅⡘",
    "⢃⠨",
    "⡃⢐",
    "⠍⡐",
    "⢋⠠",
    "⡋⢀",
    "⠍⡁",
    "⢋⠁",
    "⡋⠁",
    "⠍⠉",
    "⠋⠉",
    "⠋⠉",
    "⠉⠙",
    "⠉⠙",
    "⠉⠩",
    "⠈⢙",
    "⠈⡙",
    "⠈⠩",
    "⠀⢙",
    "⠀⡙",
    "⠀⠩",
    "⠀⢘",
    "⠀⡘",
    "⠀⠨",
    "⠀⢐",
    "⠀⡐",
    "⠀⠠",
    "⠀⢀",
    "⠀⡀",
  ],
  intervalMs: 80,
  cellWidth: 2,
};

const DIAGSWIPE: BrailleAnimation = {
  frames: [
    "⠁⠀",
    "⠋⠀",
    "⠟⠁",
    "⡿⠋",
    "⣿⠟",
    "⣿⡿",
    "⣿⣿",
    "⣿⣿",
    "⣾⣿",
    "⣴⣿",
    "⣠⣾",
    "⢀⣴",
    "⠀⣠",
    "⠀⢀",
    "⠀⠀",
    "⠀⠀",
  ],
  intervalMs: 60,
  cellWidth: 2,
};

const CHECKERBOARD: BrailleAnimation = {
  frames: ["⢋⡴⢋", "⣡⠞⣡", "⡴⢋⡴", "⠞⣡⠞"],
  intervalMs: 80,
  cellWidth: 3,
};

const COLUMNS: BrailleAnimation = {
  frames: [
    "⣄⢀⣴",
    "⣆⠀⣰",
    "⣦⡀⣠",
    "⣷⡀⢀",
    "⣷⣄⢀",
    "⣿⣆⠀",
    "⣾⣦⡀",
    "⣾⣷⡀",
    "⣴⣷⣄",
    "⣰⣿⣆",
    "⣠⣾⣦",
    "⢀⣾⣷",
    "⢀⣴⣷",
    "⠀⣰⣿",
    "⡀⣠⣾",
    "⡀⢀⣾",
  ],
  intervalMs: 100,
  cellWidth: 3,
};

const WAVEROWS: BrailleAnimation = {
  frames: [
    "⠖⠉⠉⠑",
    "⡠⠖⠉⠉",
    "⣠⡠⠖⠉",
    "⣄⣠⡠⠖",
    "⠢⣄⣠⡠",
    "⠙⠢⣄⣠",
    "⠉⠙⠢⣄",
    "⠊⠉⠙⠢",
    "⠜⠊⠉⠙",
    "⡤⠜⠊⠉",
    "⣀⡤⠜⠊",
    "⢤⣀⡤⠜",
    "⠣⢤⣀⡤",
    "⠑⠣⢤⣀",
    "⠉⠑⠣⢤",
    "⠋⠉⠑⠣",
  ],
  intervalMs: 90,
  cellWidth: 4,
};

const RAIN: BrailleAnimation = {
  frames: [
    "⢁⠂⠔⠈",
    "⠂⠌⡠⠐",
    "⠄⡐⢀⠡",
    "⡈⠠⠀⢂",
    "⠐⢀⠁⠄",
    "⠠⠁⠊⡀",
    "⢁⠂⠔⠈",
    "⠂⠌⡠⠐",
    "⠄⡐⢀⠡",
    "⡈⠠⠀⢂",
    "⠐⢀⠁⠄",
    "⠠⠁⠊⡀",
  ],
  intervalMs: 100,
  cellWidth: 4,
};

const HELIX: BrailleAnimation = {
  frames: [
    "⢌⣉⢎⣉",
    "⣉⡱⣉⡱",
    "⣉⢎⣉⢎",
    "⡱⣉⡱⣉",
    "⢎⣉⢎⣉",
    "⣉⡱⣉⡱",
    "⣉⢎⣉⢎",
    "⡱⣉⡱⣉",
    "⢎⣉⢎⣉",
    "⣉⡱⣉⡱",
    "⣉⢎⣉⢎",
    "⡱⣉⡱⣉",
    "⢎⣉⢎⣉",
    "⣉⡱⣉⡱",
    "⣉⢎⣉⢎",
    "⡱⣉⡱⣉",
  ],
  intervalMs: 80,
  cellWidth: 4,
};

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
  sand: SAND,
  snake: SNAKE,
  dots12: DOTS12,
  diagswipe: DIAGSWIPE,
  pulse: PULSE,
  checkerboard: CHECKERBOARD,
  columns: COLUMNS,
  cascade: CASCADE,
  waverows: WAVEROWS,
  rain: RAIN,
  helix: HELIX,
} as const satisfies Readonly<Record<string, BrailleAnimation>>;

export type BrailleAnimationKey = keyof typeof BRAILLE_ANIMATIONS;

export const STREAMING_STATUS_ANIMATION_KEYS: readonly BrailleAnimationKey[] = [
  "orbit",
  "breathe",
  "sand",
];

export const CONTEXT_TIER_ANIMATIONS: readonly (readonly BrailleAnimationKey[])[] =
  [
    ["orbit", "breathe", "sand"],
    ["snake", "dots12", "diagswipe"],
    ["pulse", "checkerboard", "columns"],
    ["cascade", "waverows", "rain", "helix"],
  ];

export const CONTEXT_TIER_COUNT = CONTEXT_TIER_ANIMATIONS.length;

export function contextTierFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 0.75) return 3;
  if (ratio >= 0.5) return 2;
  if (ratio >= 0.25) return 1;
  return 0;
}

export function spinnerWidthForTier(tier: number): number {
  const clamped = Math.max(0, Math.min(CONTEXT_TIER_COUNT - 1, tier));
  const pool = CONTEXT_TIER_ANIMATIONS[clamped];
  const firstKey = pool?.[0];
  if (!firstKey) return 1;
  return BRAILLE_ANIMATIONS[firstKey].cellWidth;
}
