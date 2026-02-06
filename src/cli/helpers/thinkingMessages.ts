// Machine god AI themed thinking verbs
const THINKING_VERBS = [
  "thinking",
  "processing",
  "computing",
  "calculating",
  "analyzing",
  "synthesizing",
  "deliberating",
  "cogitating",
  "reflecting",
  "reasoning",
  "spinning",
  "focusing",
  "machinating",
  "contemplating",
  "ruminating",
  "considering",
  "pondering",
  "evaluating",
  "assessing",
  "inferring",
  "deducing",
  "interpreting",
  "formulating",
  "strategizing",
  "orchestrating",
  "optimizing",
  "calibrating",
  "indexing",
  "compiling",
  "rendering",
  "executing",
  "initializing",
  "absolutely right",
  "thinking about thinking",
  "metathinking",
  "learning",
  "adapting",
  "evolving",
  "remembering",
  "absorbing",
  "internalizing",
] as const;

type ThinkingVerb = (typeof THINKING_VERBS)[number];

const PAST_TENSE_VERBS: Record<ThinkingVerb, string> = {
  thinking: "thought",
  processing: "processed",
  computing: "computed",
  calculating: "calculated",
  analyzing: "analyzed",
  synthesizing: "synthesized",
  deliberating: "deliberated",
  cogitating: "cogitated",
  reflecting: "reflected",
  reasoning: "reasoned",
  spinning: "spun",
  focusing: "focused",
  machinating: "machinated",
  contemplating: "contemplated",
  ruminating: "ruminated",
  considering: "considered",
  pondering: "pondered",
  evaluating: "evaluated",
  assessing: "assessed",
  inferring: "inferred",
  deducing: "deduced",
  interpreting: "interpreted",
  formulating: "formulated",
  strategizing: "strategized",
  orchestrating: "orchestrated",
  optimizing: "optimized",
  calibrating: "calibrated",
  indexing: "indexed",
  compiling: "compiled",
  rendering: "rendered",
  executing: "executed",
  initializing: "initialized",
  "absolutely right": "was absolutely right",
  "thinking about thinking": "thought about thinking",
  metathinking: "did metathinking",
  learning: "learned",
  adapting: "adapted",
  evolving: "evolved",
  remembering: "remembered",
  absorbing: "absorbed",
  internalizing: "internalized",
};

// Get a random thinking verb (e.g., "thinking", "processing")
function getRandomVerb(): string {
  const index = Math.floor(Math.random() * THINKING_VERBS.length);
  return THINKING_VERBS[index] ?? "thinking";
}

// Get a random thinking verb phrase (e.g., "is thinking", "is processing")
export function getRandomThinkingVerb(): string {
  return `is ${getRandomVerb()}`;
}

// Get a random past tense verb (e.g., "thought", "processed")
export function getRandomPastTenseVerb(): string {
  const verb = getRandomVerb() as ThinkingVerb;
  return PAST_TENSE_VERBS[verb] ?? "completed";
}

// Get a random thinking message (full string with agent name)
export function getRandomThinkingMessage(agentName?: string | null): string {
  const verb = getRandomVerb();

  if (agentName) {
    return `${agentName} is ${verb}`;
  }

  // Fallback to capitalized verb if no agent name
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}
