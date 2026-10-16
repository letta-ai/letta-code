import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);

  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0") {
      throw new Error(`Invalid semantic version: ${version}`);
    }
  }

  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const identifiers = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [left, right, ...extra] = process.argv.slice(2);
  if (!left || !right || extra.length > 0) {
    console.error("Usage: node scripts/compare-semver.mjs <left> <right>");
    process.exit(2);
  }

  try {
    console.log(compareSemver(left, right));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
