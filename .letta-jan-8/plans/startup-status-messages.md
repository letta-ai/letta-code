# Startup Status Messages Plan

**Status: IMPLEMENTED ✓**

## What was implemented

Status messages are now injected as transcript lines (like errors/commands) after backfill or when creating a new agent.

## Goal
Add informative status messages at startup that help developers understand the agent's provenance - whether it's resumed or new, and where memory blocks came from.

## Current State
- `WelcomeScreen.tsx` shows generic messages like "Resumed agent" or "Created a new agent"
- `createAgent()` already tracks block provenance internally but doesn't expose it
- No differentiation between resumed vs new, or block sources

## Desired Status Messages

### When Resuming an Agent
```
Resumed agent
  → Reusing memory from global (~/.letta/): persona, human
  → Reusing memory from project (.letta/): project, skills
  → To create a new agent, use --new
```

### When Creating a New Agent (default - reuses shared blocks)
```
Created new agent
  → Reusing memory from global (~/.letta/): persona, human
  → Reusing memory from project (.letta/): project, skills
```

### When Creating with --fresh-blocks
```
Created new agent with fresh memory blocks
  → New blocks: persona, human, project, skills
```

### When Creating with mixed (some reused, some new)
```
Created new agent
  → Reusing memory from global (~/.letta/): persona, human  
  → Created new blocks: project, skills
```

## Implementation

### 1. Create `AgentProvenance` type

```typescript
// src/agent/create.ts
export interface BlockProvenance {
  label: string;
  source: 'global' | 'project' | 'new';
}

export interface AgentProvenance {
  isNew: boolean;
  freshBlocks: boolean;
  blocks: BlockProvenance[];
}

export interface CreateAgentResult {
  agent: AgentState;
  provenance: AgentProvenance;
}
```

### 2. Update `createAgent()` to return provenance

Track which blocks came from where:
- `global`: reused from `~/.letta/settings.json` (globalSharedBlockIds)
- `project`: reused from `.letta/settings.json` (localSharedBlockIds)
- `new`: freshly created

### 3. Pass provenance through the startup flow

- `index.ts` LoadingApp: Track provenance from createAgent
- Pass to App.tsx as new props
- Pass to WelcomeScreen

### 4. Update `WelcomeScreen.tsx`

Add a new function `getProvenanceMessage()` that formats the status based on:
- `continueSession` (resumed vs new)
- `provenance.blocks` (where each block came from)
- `provenance.freshBlocks` (--fresh-blocks flag)

## Files to Modify

1. `src/agent/create.ts` - Add provenance tracking and return type
2. `src/index.ts` - Capture and pass provenance  
3. `src/cli/App.tsx` - Accept and pass provenance props
4. `src/cli/components/WelcomeScreen.tsx` - Display provenance messages
5. `src/headless.ts` - Optional: print provenance in headless mode too

## Key Details

- Global blocks: `persona`, `human`, `loaded_skills` 
- Project blocks: `project`, `skills`
- The paths shown should be `~/.letta/` and `.letta/` (abbreviated for clarity)
- Agent ID in resume message should be short form (first 8 chars or the name)
