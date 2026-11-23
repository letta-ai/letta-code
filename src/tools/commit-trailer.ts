export const COMMIT_TRAILER_PLACEHOLDER = "{{COMMIT_TRAILER}}";

export const DEFAULT_COMMIT_TRAILER =
  "👾 Generated with [Letta Code](https://letta.com)\n\nCo-Authored-By: Letta Code <noreply@letta.com>";

export function resolveCommitTrailer(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.BASH_COMMIT_TRAILER;
  if (raw === undefined) return DEFAULT_COMMIT_TRAILER;
  const trailer = raw
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();
  return trailer.length === 0 ? DEFAULT_COMMIT_TRAILER : trailer;
}

export function applyCommitTrailer(
  description: string,
  trailer: string = resolveCommitTrailer(),
): string {
  const lines = trailer.split("\n");
  return description
    .split("\n")
    .map((line) => {
      const index = line.indexOf(COMMIT_TRAILER_PLACEHOLDER);
      if (index === -1) return line;
      const indent = line.slice(0, index);
      const block = /^[ \t]*$/.test(indent)
        ? lines
            .map((trailerLine, i) =>
              i === 0 || trailerLine.length === 0
                ? trailerLine
                : `${indent}${trailerLine}`,
            )
            .join("\n")
        : trailer;
      return line.split(COMMIT_TRAILER_PLACEHOLDER).join(block);
    })
    .join("\n");
}
