import { useSyncExternalStore } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

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

// Shared module-level ticker for animation sync across all AnimatedLogo instances
// Single timer, guaranteed sync, no time-jump artifacts
let tick = 0;
const listeners = new Set<() => void>();
let tickerInterval: ReturnType<typeof setInterval> | null = null;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  // Start ticker on first subscriber
  if (!tickerInterval) {
    tickerInterval = setInterval(() => {
      tick++;
      for (const cb of listeners) {
        cb();
      }
    }, 100);
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

interface AnimatedLogoProps {
  color?: string;
}

export function AnimatedLogo({
  color = colors.welcome.accent,
}: AnimatedLogoProps) {
  const tick = useSyncExternalStore(subscribe, getSnapshot);
  const frame = tick % logoFrames.length;

  const logoLines = logoFrames[frame]?.split("\n") ?? [];

  return (
    <>
      {logoLines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Logo lines are static and never reorder
        <Text key={idx} bold color={color}>
          {line}
        </Text>
      ))}
    </>
  );
}
