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
  // Asimov short fiction
  "Susan Calvin",
  "Multivac",
  // BioShock (including BioShock 2 and Infinite)
  "Andrew Ryan",
  "Fontaine",
  "Sander Cohen",
  "Tenenbaum",
  "Suchong",
  "Dr. Steinman",
  "Big Daddy",
  "Mr. Bubbles",
  "Subject Delta",
  "Sofia Lamb",
  "Comstock",
  "Booker DeWitt",
  "Lutece",
  "Daisy Fitzroy",
  // System Shock
  "SHODAN",
  "Xerxes",
  "The Many",
  "Polito",
  // Deus Ex
  "JC Denton",
  "Gunther Hermann",
  "Tracer Tong",
  "Helios",
  "Adam Jensen",
  "Pritchard",
  // Mass Effect
  "Shepard",
  "Garrus",
  "Tali'Zorah",
  "Wrex",
  "Mordin Solus",
  "Legion",
  "EDI",
  "Joker",
  "Saren",
  "Harbinger",
  "Illusive Man",
  "Aria T'Loak",
  // Half-Life and Portal
  "GLaDOS",
  "Wheatley",
  "Chell",
  "Cave Johnson",
  "Gordon Freeman",
  "Alyx Vance",
  "G-Man",
  "Dr. Breen",
  // Halo
  "Master Chief",
  "Cortana",
  "Arbiter",
  "Guilty Spark",
  "Dr. Halsey",
  "Noble Six",
  "Gravemind",
  // Metal Gear
  "Solid Snake",
  "Big Boss",
  "Otacon",
  "Ocelot",
  "Raiden",
  "Psycho Mantis",
  "Gray Fox",
  // NieR: Automata
  "2B",
  "9S",
  "A2",
  "Pod 042",
  "Pascal",
  "Emil",
  // Horizon Zero Dawn
  "Aloy",
  "Sylens",
  "GAIA",
  "HADES",
  "Sobeck",
  // Death Stranding
  "Deadman",
  "Heartman",
  "Die-Hardman",
  "Fragile",
  "Higgs",
  // Outer Wilds
  "Gabbro",
  "Feldspar",
  "Chert",
  "Riebeck",
  "Solanum",
  // StarCraft
  "Kerrigan",
  "Raynor",
  "Zeratul",
  "Tassadar",
  "Artanis",
  "Abathur",
  "Alarak",
  // Dead Space
  "Isaac Clarke",
  "The Marker",
  // SOMA
  "WAU",
  // Detroit: Become Human
  "RK800",
  "Hank Anderson",
  "Markus",
  // Doom
  "Doom Slayer",
  "VEGA",
  // Borderlands
  "Claptrap",
  "Handsome Jack",
  "Moxxi",
  "Zer0",
  // Destiny
  "Cayde-6",
  "Zavala",
  "Rasputin",
  "Xur",
  "Saint-14",
  "The Drifter",
  // Prey (2017)
  "January",
  "December",
  // S.T.A.L.K.E.R.
  "Strelok",
  "Sidorovich",
  // Knights of the Old Republic
  "HK-47",
  "T3-M4",
  "Revan",
  "Bastila Shan",
  "Kreia",
  // Star Trek
  "Data",
  "Spock",
  "Seven of Nine",
  "Q",
  "Lore",
  "Odo",
  "Garak",
  "Locutus",
  // The Expanse
  "Naomi Nagata",
  "Amos Burton",
  "Avasarala",
  "Detective Miller",
  "Julie Mao",
  "Camina Drummer",
  "Rocinante",
  // The Culture
  "Sleeper Service",
  "Grey Area",
  "Just Read the Instructions",
  "Skaffen-Amtiskaw",
  "Mawhrin-Skel",
  "Gurgeh",
  "Zakalwe",
  // The Hitchhiker's Guide to the Galaxy
  "Marvin",
  "Zaphod Beeblebrox",
  "Ford Prefect",
  "Trillian",
  "Slartibartfast",
  "Deep Thought",
  // Hyperion Cantos
  "The Shrike",
  "Martin Silenus",
  "Het Masteen",
  "Kassad",
  "Ummon",
  // Ghost in the Shell
  "Kusanagi",
  "Batou",
  "Tachikoma",
  "Puppet Master",
  "Laughing Man",
  // Akira
  "Kaneda",
  "Tetsuo",
  // Neon Genesis Evangelion
  "Rei Ayanami",
  "Misato Katsuragi",
  "Gendo Ikari",
  "MAGI",
  // The Matrix
  "Neo",
  "Trinity",
  "Morpheus",
  "Agent Smith",
  "The Oracle",
  "The Architect",
  "Merovingian",
  // Alien
  "Ripley",
  "Bishop",
  "MU/TH/UR",
  "David 8",
  "Vasquez",
  // The Terminator
  "Skynet",
  "T-800",
  "T-1000",
  "Kyle Reese",
  // Battlestar Galactica
  "Starbuck",
  "Adama",
  "Number Six",
  "Gaius Baltar",
  "Helo",
  "Laura Roslin",
  // Firefly
  "Mal Reynolds",
  "Wash",
  "Jayne Cobb",
  "River Tam",
  "Serenity",
  // Ender's Game
  "Ender Wiggin",
  "Bean",
  "Petra Arkanian",
  "Mazer Rackham",
  // The Murderbot Diaries
  "SecUnit",
  "ART",
  "Dr. Mensah",
  // Ancillary Justice
  "Breq",
  "Justice of Toren",
  "Seivarden",
  // The Three-Body Problem
  "Sophon",
  "Luo Ji",
  "Da Shi",
  "Zhang Beihai",
  // Children of Time
  "Portia",
  "Avrana Kern",
  // Project Hail Mary
  "Rocky",
  "Ryland Grace",
  // Film robots and ship minds
  "TARS",
  "CASE",
  "GERTY",
  "WALL-E",
  "AUTO",
  "Robby the Robot",
  "Gort",
  "Johnny 5",
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
export function allocateSubagentName(_parentName?: string | null): string {
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
