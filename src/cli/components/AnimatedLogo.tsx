import { useSyncExternalStore } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const LOGO_WIDTH = 10;

// Logo frames use abstract cell tokens instead of block/shade glyphs.
// Rendering via backgroundColor makes each logo pixel a terminal cell, avoiding
// font/terminal-specific rendering differences for Unicode block elements.
const logoFrames = [
  // 1. Front view (fully facing)
  `  FFFFFF
FF      FF
FF  FF  FF
FF      FF
  FFFFFF  `,
  // 2. Just starting to turn right
  `  DFFFFF
DF      DF
DF  DF  DF
DF      DF
  DFFFFF  `,
  // 3. Slight right turn
  `  DDFFFF
DD      DD
DD  DD  DD
DD      DD
  DDFFFF  `,
  // 4. More right (gradient deepening)
  `  SDDFFF
SDD    SDD
SDD SD SDD
SDD    SDD
  SDDFFF  `,
  // 5. Even more right
  `  SSDDFF
 SDD  SDD
 SDDSDSDD
 SDD  SDD
  SSDDFF  `,
  // 6. Approaching side
  `   SDDF
  SSDSSD
  SSDDSD
  SSDSSD
   SDDF   `,
  // 7. Almost side
  `   SDDD
   SDSD
   SDDD
   SDSD
   SDDD   `,
  // 8. Side view
  `   DDDD
   DDDD
   DDDD
   DDDD
   DDDD   `,
  // 9. Leaving side (mirror of 7)
  `   DDDS
   DSDS
   DDDS
   DSDS
   DDDS   `,
  // 10. Past side (mirror of 6)
  `   FDDS
  DSSDSS
  DSDDSS
  DSSDSS
   FDDS   `,
  // 11. More past side (mirror of 5)
  `  FFDDSS
 DDS  DDS
 DDSDSDDS
 DDS  DDS
  FFDDSS  `,
  // 12. Returning (mirror of 4)
  `  FFFDDS
DDS    DDS
DDS DS DDS
DDS    DDS
  FFFDDS  `,
  // 13. Almost front (mirror of 3)
  `  FFFFDD
DD      DD
DD  DD  DD
DD      DD
  FFFFDD  `,
  // 14. Nearly front (mirror of 2)
  `  FFFFFD
FD      FD
FD  FD  FD
FD      FD
  FFFFFD  `,
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

function logoCellColor(token: string, faceColor: string): string | undefined {
  if (token === "F") return faceColor;
  if (token === "D") return "#7272E5";
  if (token === "S") return "#5454B8";
  return undefined;
}

function renderLogoLine(line: string, faceColor: string) {
  return Array.from(line).map((token, idx) => {
    const backgroundColor = logoCellColor(token, faceColor);

    return (
      <Text
        // biome-ignore lint/suspicious/noArrayIndexKey: Logo cells are fixed per line
        key={idx}
        backgroundColor={backgroundColor}
      >
        {" "}
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
