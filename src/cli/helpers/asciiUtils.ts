/**
 * Calculates the maximum width of a multi-line ASCII art string.
 * @param asciiArt The ASCII art string.
 * @returns The length of the longest line in the ASCII art.
 */
export function getAsciiArtWidth(asciiArt: string): number {
  if (!asciiArt) {
    return 0;
  }
  const lines = asciiArt.split("\n");
  return Math.max(...lines.map((line) => line.length));
}
