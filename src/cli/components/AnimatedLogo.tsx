import { Text } from "ink";
import { useEffect, useState } from "react";
import { colors } from "./colors";

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

interface AnimatedLogoProps {
  color?: string;
}

export function AnimatedLogo({
  color = colors.welcome.accent,
}: AnimatedLogoProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % logoFrames.length);
    }, 100);

    return () => clearInterval(timer);
  }, []);

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
