import { Text } from "ink";
import { useEffect, useState } from "react";
import { colors } from "./colors";

// Define animation frames - 3D rotation effect with gradient (█ → ▓ → ▒ → ░)
// Each frame is 14x14 (14 chars wide, 7 lines tall for 2:1 char aspect ratio)
const logoFrames = [
	// Front view (fully facing)
`
   ████████
 ██        ██
██          ██
██    ██    ██
██          ██
 ██        ██
   ████████   `,
	// Slight right turn
`
   ▓▓██████
  ▓█      ▓█
 ▓█        ▓█
 ▓█   ▓█   ▓█
 ▓█        ▓█
  ▓█      ▓█
   ▓▓██████  `,
	// More right
`
     ░▓▓▓▓▓
    ░▓    ░▓
   ░▓      ░▓
   ░▓  ░▓  ░▓
   ░▓      ░▓
    ░▓    ░▓
     ░▓▓▓▓▓  `,
	// Side view
`
      ▓▓▓▓
      ████
      ████
      ████
      ████
      ████
      ▓▓▓▓    `,
	// Past side (mirror of "More right")
`
     ▓▓▓▓▓░
    ▓░    ▓░
   ▓░      ▓░
   ▓░  ▓░  ▓░
   ▓░      ▓░
    ▓░    ▓░
     ▓▓▓▓▓░  `,
	// Returning to front (mirror of "Slight right turn")
`
   ██████▓▓
  █▓      █▓
 █▓        █▓
 █▓   █▓   █▓
 █▓        █▓
  █▓      █▓
   ██████▓▓  `,
];


interface AnimatedLogoProps {
	color?: string;
}

export function AnimatedLogo({ color = colors.welcome.accent }: AnimatedLogoProps) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((prev) => (prev + 1) % logoFrames.length);
		}, 150); // Change frame every 120ms for smooth rotation

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
