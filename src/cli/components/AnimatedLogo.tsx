import type { ChalkInstance } from "chalk";
import { useSyncExternalStore } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const LOGO_WIDTH = 10;

const logoFrames = [
  `  FFFFFF
FF      FF
FF  FF  FF
FF      FF
  FFFFFF  `,
  `  DFFFFF
DF      DF
DF  DF  DF
DF      DF
  DFFFFF  `,
  `  DDFFFF
DD      DD
DD  DD  DD
DD      DD
  DDFFFF  `,
  `  SDDFFF
SDD    SDD
SDD SD SDD
SDD    SDD
  SDDFFF  `,
  `  SSDDFF
 SDD  SDD
 SDDSDSDD
 SDD  SDD
  SSDDFF  `,
  `   SDDF
  SSDSSD
  SSDDSD
  SSDSSD
   SDDF   `,
  `   SDDD
   SDSD
   SDDD
   SDSD
   SDDD   `,
  `   DDDD
   DDDD
   DDDD
   DDDD
   DDDD   `,
  `   DDDS
   DSDS
   DDDS
   DSDS
   DDDS   `,
  `   FDDS
  DSSDSS
  DSDDSS
  DSSDSS
   FDDS   `,
  `  FFDDSS
 DDS  DDS
 DDSDSDDS
 DDS  DDS
  FFDDSS  `,
  `  FFFDDS
DDS    DDS
DDS DS DDS
DDS    DDS
  FFFDDS  `,
  `  FFFFDD
DD      DD
DD  DD  DD
DD      DD
  FFFFDD  `,
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

let tick = 0;
const listeners = new Set<() => void>();
let tickerInterval: ReturnType<typeof setInterval> | null = null;

const FRAME_SEQUENCE = [
  0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13,
] as const;
const FRAME_INTERVAL_MS = 75;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
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

export function staticLogoLines(
  paint: ChalkInstance,
  faceColor: string = colors.welcome.accent,
): string[] {
  const lines = normalizedLogoFrames[1]?.split("\n") ?? [];
  return lines.map((line) =>
    Array.from(line)
      .map((token) => {
        const bg = logoCellColor(token, faceColor);
        return bg ? paint.bgHex(bg)(" ") : " ";
      })
      .join(""),
  );
}

interface AnimatedLogoProps {
  color?: string;
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
