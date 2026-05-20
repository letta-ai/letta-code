import { useSyncExternalStore } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const LOGO_WIDTH = 10;

// Define animation frames - 3D rotation effect with gradient (█ → ▓ → ▒ → ░)
// Each frame is ~10 chars wide, 5 lines tall - matches login dialog asciiLogo size
const logoFrames = [
  // 1. Front view (fully facing)
  `  ██████
██      ██
██  ██  ██
██      ██
  ██████  `,
  // 2. Just starting to turn right
  `  ▓█████
▓█      ▓█
▓█  ▓█  ▓█
▓█      ▓█
  ▓█████  `,
  // 3. Slight right turn
  `  ▓▓████
▓▓      ▓▓
▓▓  ▓▓  ▓▓
▓▓      ▓▓
  ▓▓████  `,
  // 4. More right (gradient deepening)
  `  ░▓▓███
░▓▓    ░▓▓
░▓▓ ░▓ ░▓▓
░▓▓    ░▓▓
  ░▓▓███  `,
  // 5. Even more right
  `  ░░▓▓██
 ░▓▓  ░▓▓
 ░▓▓░▓░▓▓
 ░▓▓  ░▓▓
  ░░▓▓██  `,
  // 6. Approaching side
  `   ░▓▓█
  ░░▓░░▓
  ░░▓▓░▓
  ░░▓░░▓
   ░▓▓█   `,
  // 7. Almost side
  `   ░▓▓▓
   ░▓░▓
   ░▓▓▓
   ░▓░▓
   ░▓▓▓   `,
  // 8. Side view
  `   ▓▓▓▓
   ▓▓▓▓
   ▓▓▓▓
   ▓▓▓▓
   ▓▓▓▓   `,
  // 9. Leaving side (mirror of 7)
  `   ▓▓▓░
   ▓░▓░
   ▓▓▓░
   ▓░▓░
   ▓▓▓░   `,
  // 10. Past side (mirror of 6)
  `   █▓▓░
  ▓░░▓░░
  ▓░▓▓░░
  ▓░░▓░░
   █▓▓░   `,
  // 11. More past side (mirror of 5)
  `  ██▓▓░░
 ▓▓░  ▓▓░
 ▓▓░▓░▓▓░
 ▓▓░  ▓▓░
  ██▓▓░░  `,
  // 12. Returning (mirror of 4)
  `  ███▓▓░
▓▓░    ▓▓░
▓▓░ ▓░ ▓▓░
▓▓░    ▓▓░
  ███▓▓░  `,
  // 13. Almost front (mirror of 3)
  `  ████▓▓
▓▓      ▓▓
▓▓  ▓▓  ▓▓
▓▓      ▓▓
  ████▓▓  `,
  // 14. Nearly front (mirror of 2)
  `  █████▓
█▓      █▓
█▓  █▓  █▓
█▓      █▓
  █████▓  `,
];

function padFrameToFixedWidth(frame: string, width: number): string {
  return frame
    .split("\n")
    .map((line) => line.padEnd(width, " "))
    .join("\n");
}

const normalizedLogoFrames = logoFrames.map((frame) =>
  padFrameToFixedWidth(frame, LOGO_WIDTH),
);

// Shared module-level ticker for animation sync across all AnimatedLogo instances
// Single timer, guaranteed sync, no time-jump artifacts
let tick = 0;
const listeners = new Set<() => void>();
let tickerInterval: ReturnType<typeof setInterval> | null = null;

const FRAME_SEQUENCE = [
  0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13,
] as const;
const FRAME_INTERVAL_MS = 75;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  // Start ticker on first subscriber
  if (!tickerInterval) {
    tickerInterval = setInterval(() => {
      tick++;
      for (const cb of listeners) {
        cb();
      }
    }, FRAME_INTERVAL_MS);
  }
  return () => {
    listeners.delete(callback);
    // Stop ticker when no subscribers
    if (listeners.size === 0 && tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

function renderLogoLine(line: string, faceColor: string) {
  return Array.from(line).map((char, idx) => {
    const glyphColor =
      char === "░" ? "#5454B8" : char === "▓" ? "#7272E5" : faceColor;

    return (
      <Text
        // biome-ignore lint/suspicious/noArrayIndexKey: Logo glyphs are fixed per line
        key={idx}
        color={char === " " ? undefined : glyphColor}
      >
        {char}
      </Text>
    );
  });
}

interface AnimatedLogoProps {
  color?: string;
  /** When false, show static frame 1 (logo with shadow). Defaults to true. */
  animate?: boolean;
}

export function AnimatedLogo({
  color = colors.welcome.accent,
  animate = true,
}: AnimatedLogoProps) {
  const tick = useSyncExternalStore(subscribe, getSnapshot);
  const sequenceIndex = tick % FRAME_SEQUENCE.length;
  const frame = animate ? (FRAME_SEQUENCE[sequenceIndex] ?? 0) : 1;

  const logoLines = normalizedLogoFrames[frame]?.split("\n") ?? [];

  return (
    <>
      {logoLines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Logo lines are static and never reorder
        <Text key={idx} bold>
          {renderLogoLine(line, color)}
        </Text>
      ))}
    </>
  );
}
