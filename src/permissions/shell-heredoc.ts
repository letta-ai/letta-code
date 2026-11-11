import { stripShellQuotes } from "./shell-analysis";

export function extractHeredocWrite(segment: string): {
  path: string;
  delimiter: string;
  literalBody: boolean;
} | null {
  const match = segment.match(
    /^cat\s+(?:(?:>|>>)\s*(?<path1>"[^"]+"|'[^']+'|\S+)\s+<<-?\s*(?<delim1>"[^"]+"|'[^']+'|\S+)|<<-?\s*(?<delim2>"[^"]+"|'[^']+'|\S+)\s+(?:>|>>)\s*(?<path2>"[^"]+"|'[^']+'|\S+))\s*$/,
  );
  if (!match?.groups) return null;
  const rawPath = match.groups.path1 || match.groups.path2;
  const rawDelim = match.groups.delim1 || match.groups.delim2;
  if (!rawPath || !rawDelim) return null;

  // Only simple delimiters have unambiguous quote removal here.
  const literalBody =
    /^(?:'[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*")$/.test(rawDelim);
  if (!literalBody && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawDelim)) return null;
  return {
    path: stripShellQuotes(rawPath),
    delimiter: stripShellQuotes(rawDelim),
    literalBody,
  };
}
