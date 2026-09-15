import { DEFAULT_AGENT_NAME } from "@/constants";

export const SUBAGENT_NAMES = [
  // Prefer distinctive handles, surnames, and titles over ordinary first names.
  // Blade Runner
  "Deckard",
  "Roy Batty",
  "Pris",
  "Zhora",
  "Gaff",
  "Tyrell",
  // Blade Runner 2049
  "K",
  "Joi",
  "Luv",
  "Sapper",
  "Freysa",
  // Ex Machina
  "Ava",
  "Kyoko",
  // Cyberpunk 2077 (including Phantom Liberty)
  "V",
  "Silverhand",
  "Panam",
  "Rogue",
  "Alt Cunningham",
  "Takemura",
  "Hanako",
  "Yorinobu",
  "Saburo",
  "Oda",
  "T-Bug",
  "Delamain",
  "Wakako",
  "Padre",
  "El Capitan",
  "Mr. Hands",
  "Placide",
  "Dum Dum",
  "Nix",
  "Weyland",
  "Scorpion",
  "Blue Moon",
  "Red Menace",
  "Purple Force",
  "Lizzy Wizzy",
  "Ozob",
  "Smasher",
  "Songbird",
  "Slider",
  "Aguilar",
  // Fallout
  "Dogmeat",
  "Codsworth",
  "Nick Valentine",
  "Yes Man",
  "Mr. House",
  "ED-E",
  "Fisto",
  "Liberty Prime",
  "Three Dog",
  "Charon",
  "Fawkes",
  "Ulysses",
  "The Master",
  "Muggy",
  "Dr. Mobius",
  "Dr. Klein",
  "Old Longfellow",
  "Pickman",
  "Butch DeLoria",
  "Fantastic",
  // Dune
  "Muad'Dib",
  "Stilgar",
  "Chani",
  "Gurney Halleck",
  "Duncan Idaho",
  "Thufir Hawat",
  "Liet-Kynes",
  "Shadout Mapes",
  "Feyd-Rautha",
  "Rabban",
  "Piter De Vries",
  "Irulan",
  "Scytale",
  "Hayt",
  "Bijaz",
  "Moneo",
  "Miles Teg",
  "Darwi Odrade",
  "Sheeana",
  "Shaddam IV",
  "Count Fenring",
  // Neuromancer
  "Wintermute",
  "Neuromancer",
  "Dixie Flatline",
  "Molly Millions",
  "Lady 3Jane",
  "Armitage",
  "Maelcum",
  "Ratz",
  "The Finn",
  // Snow Crash
  "Hiro Protagonist",
  "Y.T.",
  "Raven",
  "Uncle Enzo",
  // Foundation and Robot novels
  "R. Daneel Olivaw",
  "R. Giskard Reventlov",
  "Hari Seldon",
  "Dors Venabili",
  "The Mule",
  // 2001: A Space Odyssey
  "HAL 9000",
  // Accelerando
  "Aineko",
  // Singularity Sky
  "Eschaton",
  // Terra Ignota
  "Mycroft Canner",
  "J.E.D.D. Mason",
  "Sniper",
  "Eureka Weeksbooth",
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
    return `${name}${round === 1 ? "" : ` the ${ordinal}`}`;
  };
}

const nextName = createSubagentNameAllocator();

/** Allocate in the parent before spawning, so sibling CLI processes cannot collide. */
export function allocateSubagentName(parentName?: string | null): string {
  const parent = parentName?.trim();
  return `${nextName()} (${parent ? `${parent}'s shadow` : "shadow"})`;
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
