import { DEFAULT_AGENT_NAME } from "@/constants";

export const SUBAGENT_NAMES = [
  // Blade Runner
  "Deckard",
  "Rachael",
  "Roy",
  "Pris",
  "Zhora",
  "Leon",
  "Gaff",
  "Tyrell",
  "Sebastian",
  "Bryant",
  "Chew",
  "Holden",
  "Taffey",
  // Blade Runner 2049
  "K",
  "Joi",
  "Luv",
  "Wallace",
  "Joshi",
  "Sapper",
  "Mariette",
  "Freysa",
  "Ana",
  "Coco",
  // Her
  "Samantha",
  "Theodore",
  "Amy",
  "Catherine",
  "Paul",
  "Isabella",
  // Ex Machina
  "Ava",
  "Caleb",
  "Nathan",
  "Kyoko",
  // Cyberpunk 2077 (including Phantom Liberty)
  "V",
  "Johnny",
  "Jackie",
  "Judy",
  "Panam",
  "River",
  "Kerry",
  "Rogue",
  "Alt",
  "Evelyn",
  "Takemura",
  "Hanako",
  "Yorinobu",
  "Saburo",
  "Oda",
  "Viktor",
  "Misty",
  "Dex",
  "T-Bug",
  "Delamain",
  "Wakako",
  "Padre",
  "Regina",
  "Dakota",
  "Dino",
  "El Capitan",
  "Mr. Hands",
  "Placide",
  "Brigitte",
  "Royce",
  "Dum Dum",
  "Brick",
  "Meredith",
  "Sandra",
  "Maiko",
  "Claire",
  "Nix",
  "Weyland",
  "Saul",
  "Mitch",
  "Scorpion",
  "Cassidy",
  "Carol",
  "Denny",
  "Nancy",
  "Henry",
  "Blue Moon",
  "Red Menace",
  "Purple Force",
  "Lizzy",
  "Ozob",
  "Smasher",
  "Reed",
  "Songbird",
  "Alex",
  "Myers",
  "Hansen",
  "Paco",
  "Babs",
  "Slider",
  "Aurore",
  "Aymeric",
  "Aguilar",
  "Bree",
  "Dante",
  "Lina",
  "Garry",
  "Pepe",
] as const;

/** Each process keeps its own pool; completed and failed launches do not return names. */
export function createSubagentNameAllocator(
  random: () => number = Math.random,
) {
  let available: string[] = [];
  let round = 0;
  const ordinals = new Intl.PluralRules("en", { type: "ordinal" });
  const suffixes: Record<string, string> = { one: "st", two: "nd", few: "rd" };

  return () => {
    if (available.length === 0) {
      available = [...SUBAGENT_NAMES];
      round += 1;
    }
    const index = Math.floor(random() * available.length);
    const name = available.splice(index, 1)[0];
    const ordinal = `${round}${suffixes[ordinals.select(round)] ?? "th"}`;
    return `${name}${round === 1 ? "" : ` the ${ordinal}`} (subagent)`;
  };
}

const nextName = createSubagentNameAllocator();

/** Allocate in the parent before spawning, so sibling CLI processes cannot collide. */
export function allocateSubagentName(): string {
  return nextName();
}

export function resolveCreatedAgentName(
  name: string | undefined,
  isSubagent: boolean,
  assignedName?: string,
): string {
  return (
    name ??
    (isSubagent ? assignedName || allocateSubagentName() : DEFAULT_AGENT_NAME)
  );
}
