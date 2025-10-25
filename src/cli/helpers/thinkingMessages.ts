// Machine god AI themed thinking messages
const THINKING_MESSAGES = [
  "Thinking",
  "Processing",
  "Computing",
  "Calculating",
  "Analyzing",
  "Synthesizing",
  "Deliberating",
  "Cogitating",
  "Reflecting",
  "Reasoning",
  "Spinning",
  "Focusing",
  "Machinating",
  "Contemplating",
  "Ruminating",
  "Considering",
  "Pondering",
  "Evaluating",
  "Assessing",
  "Inferring",
  "Deducing",
  "Interpreting",
  "Formulating",
  "Strategizing",
  "Orchestrating",
  "Optimizing",
  "Calibrating",
  "Indexing",
  "Compiling",
  "Rendering",
  "Executing",
  "Initializing",
] as const;

// Get a random thinking message
export function getRandomThinkingMessage(): string {
  const index = Math.floor(Math.random() * THINKING_MESSAGES.length);
  return THINKING_MESSAGES[index] ?? "Thinking";
}
