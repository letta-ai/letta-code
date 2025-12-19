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
] as const;

// Get a random thinking verb phrase (e.g., "is thinking", "is processing")
export function getRandomThinkingVerb(): string {
  const index = Math.floor(Math.random() * THINKING_VERBS.length);
  const verb = THINKING_VERBS[index] ?? "thinking";
  return `is ${verb}`;
}

// Get a random thinking message (full string with agent name)
export function getRandomThinkingMessage(agentName?: string | null): string {
  const verb = getRandomThinkingVerb();

  if (agentName) {
    return `${agentName} ${verb}`;
  }

  // Fallback to capitalized verb if no agent name
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}
