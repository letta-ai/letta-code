import { homedir } from "node:os";
import { join } from "node:path";

const adjectives = [
  "bold",
  "bright",
  "calm",
  "clever",
  "crisp",
  "daring",
  "eager",
  "fair",
  "gentle",
  "happy",
  "keen",
  "lively",
  "merry",
  "nimble",
  "playful",
  "quick",
  "radiant",
  "serene",
  "swift",
  "vivid",
  "warm",
  "witty",
  "zealous",
  "agile",
  "breezy",
  "charming",
  "dazzling",
  "elegant",
  "fancy",
  "golden",
  "humble",
  "jolly",
  "kind",
  "lucky",
  "mystic",
  "noble",
  "peaceful",
  "quiet",
  "rolling",
  "shiny",
  "tender",
  "upbeat",
  "valiant",
  "whimsy",
  "youthful",
  "zesty",
];

const nouns = [
  "apple",
  "brook",
  "cloud",
  "dawn",
  "elm",
  "fern",
  "grove",
  "hill",
  "iris",
  "jade",
  "kite",
  "lake",
  "maple",
  "nest",
  "oak",
  "pine",
  "quartz",
  "river",
  "stone",
  "tide",
  "umbra",
  "vine",
  "wave",
  "yarn",
  "zenith",
  "acorn",
  "birch",
  "coral",
  "dune",
  "ember",
  "frost",
  "glade",
  "harbor",
  "ivy",
  "jasper",
  "kelp",
  "lotus",
  "moss",
  "nova",
  "opal",
  "pebble",
  "plum",
  "reed",
  "sage",
  "thorn",
  "violet",
  "willow",
  "zephyr",
];

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export function generatePlanName(): string {
  const adj1 = randomElement(adjectives);
  const adj2 = randomElement(adjectives);
  const noun = randomElement(nouns);
  return `${adj1}-${adj2}-${noun}`;
}

export function generatePlanFilePath(): string {
  const name = generatePlanName();
  return join(homedir(), ".letta", "plans", `${name}.md`);
}
