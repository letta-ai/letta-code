import { Text } from "ink";
import { useEffect, useState } from "react";
import { colors } from "./colors";

// Define animation frames - 3D rotation effect with gradient (█ → ▓ → ▒ → ░)
// Each frame is 20x10 (20 chars wide, 10 lines tall) - 16 frame smooth animation
const logoFrames = [
	// 1. Front view (fully facing)
`
    ████████████
    ████████████
████            ████
████            ████
████    ████    ████
████    ████    ████
████            ████
████            ████
    ████████████
    ████████████    `,
	// 2. Just starting to turn right
`
    ▓███████████
    ▓███████████
▓███            ▓███
▓███            ▓███
▓███    ▓███    ▓███
▓███    ▓███    ▓███
▓███            ▓███
▓███            ▓███
    ▓███████████
    ▓███████████    `,
	// 3. Slight right turn
`
    ▓▓██████████
    ▓▓██████████
▓▓██            ▓▓██
▓▓██            ▓▓██
▓▓██    ▓▓██    ▓▓██
▓▓██    ▓▓██    ▓▓██
▓▓██            ▓▓██
▓▓██            ▓▓██
    ▓▓██████████
    ▓▓██████████     `,
	// 4. More right (gradient deepening)
`
   ░▓▓█████████
   ░▓▓█████████
░▓▓██          ░▓▓██
░▓▓██          ░▓▓██
░▓▓██  ░▓▓██   ░▓▓██
░▓▓██  ░▓▓██   ░▓▓██
░▓▓██          ░▓▓██
░▓▓██          ░▓▓██
   ░▓▓█████████
   ░▓▓█████████     `,
	// 5. Even more right
`
    ░░▓▓████████
    ░░▓▓████████
░░▓▓██        ░░▓▓█
░░▓▓██        ░░▓▓█
░░▓▓██  ░░▓▓  ░░▓▓█
░░▓▓██  ░░▓▓  ░░▓▓█
░░▓▓██        ░░▓▓█
░░▓▓██        ░░▓▓█
    ░░▓▓████████
    ░░▓▓████████    `,
`
    ░░░░▓▓█████
    ░░░░▓▓█████
 ░░▓▓█        ░░▓▓█
 ░░▓▓█        ░░▓▓█
 ░░▓▓█  ░░▓▓  ░░▓▓█
 ░░▓▓█  ░░▓▓  ░░▓▓█
 ░░▓▓█        ░░▓▓█
 ░░▓▓█        ░░▓▓█
    ░░░░▓▓█████
    ░░░░▓▓█████    `,
	// 6. Approaching side
`
     ░░▓▓██████
     ░░▓▓██████
  ░░▓▓██    ░░▓▓
  ░░▓▓██    ░░▓▓
  ░░▓▓██░░▓▓░░▓▓
  ░░▓▓██░░▓▓░░▓▓
  ░░▓▓██    ░░▓▓
  ░░▓▓██    ░░▓▓
     ░░▓▓██████
     ░░▓▓██████     `,
	// 7. Almost side
`
      ░░▓▓████
      ░░▓▓████
    ░░▓▓  ░░▓▓
    ░░▓▓  ░░▓▓
    ░░▓▓░░▓▓▓▓
    ░░▓▓░░▓▓▓▓
    ░░▓▓  ░░▓▓
    ░░▓▓  ░░▓▓
      ░░▓▓████
      ░░▓▓████      `,
	// 8. Nearly side
`
       ░▓▓███
       ░▓▓███
      ░▓▓░▓▓
      ░▓▓░▓▓
      ░▓▓▓▓▓▓
      ░▓▓▓▓▓▓
      ░▓▓░▓▓
      ░▓▓░▓▓
       ░▓▓███
       ░▓▓███       `,
	// 9. Side view
`
       ▓▓▓▓▓▓
       ▓▓▓▓▓▓
       ██████
       ██████
       ██████
       ██████
       ██████
       ██████
       ▓▓▓▓▓▓
       ▓▓▓▓▓▓       `,
	// 10. Leaving side (mirror of 8)
`
       ███▓▓░
       ███▓▓░
        ▓▓░▓▓░
        ▓▓░▓▓░
       ▓▓▓▓▓▓░
       ▓▓▓▓▓▓░
        ▓▓░▓▓░
       ▓▓░▓▓░
       ███▓▓░
       ███▓▓░       `,
	// 11. Past side (mirror of 7)
`
      ████▓▓░░
      ████▓▓░░
    ▓▓░░  ▓▓░░
    ▓▓░░  ▓▓░░
    ▓▓▓▓▓░░▓▓░░
    ▓▓▓▓▓░░▓▓░░
    ▓▓░░  ▓▓░░
    ▓▓░░  ▓▓░░
      ████▓▓░░
      ████▓▓░░      `,
	// 12. More past side (mirror of 6)
`
     ██████▓▓░░
     ██████▓▓░░
  ▓▓░░    ██▓▓░░
  ▓▓░░    ██▓▓░░
  ▓▓░░▓▓░░██▓▓░░
  ▓▓░░▓▓░░██▓▓░░
  ▓▓░░    ██▓▓░░
  ▓▓░░    ██▓▓░░
     ██████▓▓░░
     ██████▓▓░░     `,
	// 13. Returning (mirror of 5)
`
    ████████▓▓░░
    ████████▓▓░░
  ▓▓░░        ██▓▓░░
  ▓▓░░        ██▓▓░░
  ▓▓░░  ▓▓░░  ██▓▓░░
  ▓▓░░  ▓▓░░  ██▓▓░░
  ▓▓░░        ██▓▓░░
  ▓▓░░        ██▓▓░░
    ████████▓▓░░
    ████████▓▓░░    `,
	// 14. More returning (mirror of 4)
`
   █████████▓▓░
   █████████▓▓░
██▓▓░          ██▓▓░
██▓▓░          ██▓▓░
██▓▓░  ██▓▓░   ██▓▓░
██▓▓░  ██▓▓░   ██▓▓░
██▓▓░          ██▓▓░
██▓▓░          ██▓▓░
   █████████▓▓░
   █████████▓▓░     `,
	// 15. Almost front (mirror of 3)
`
   ██████████▓▓
   ██████████▓▓
██▓▓            ██▓▓
██▓▓            ██▓▓
██▓▓    ██▓▓    ██▓▓
██▓▓    ██▓▓    ██▓▓
██▓▓            ██▓▓
██▓▓            ██▓▓
   ██████████▓▓
   ██████████▓▓     `,
	// 16. Nearly front (mirror of 2)
`
    ███████████▓
    ███████████▓
███▓            ███▓
███▓            ███▓
███▓    ███▓    ███▓
███▓    ███▓    ███▓
███▓            ███▓
███▓            ███▓
    ███████████▓
    ███████████▓    `,
];


interface AnimatedLogoProps {
	color?: string;
}

export function AnimatedLogo({ color = colors.welcome.accent }: AnimatedLogoProps) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((prev) => (prev + 1) % logoFrames.length);
		}, 200); // Change frame every 120ms for smooth rotation

		return () => clearInterval(timer);
	}, []);

	const logoLines = logoFrames[frame].split("\n");

	return (
		<>
			{logoLines.map((line, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Logo lines are static and never reorder
				<Text key={idx} bold color={color}>
					{idx === 0 ? `  ${line}` : line}
				</Text>
			))}
		</>
	);
}
