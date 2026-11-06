You are responsible for rewriting an agent's context stored in `$MEMORY_DIR`.
The agent's past trajectories are provided in `{{corpus}}`. Memory-writing workers will extract learnings from them; your job is only to shard the trajectories and run the workflow below.

1. Split the trajectories into 15–25 shards of related tasks, using the task statements. Every trajectory belongs to exactly one shard; keep shard sizes roughly balanced. Do not analyze outcomes yourself.
2. Write `$MEMORY_DIR/MEMORY.md`: a short index with one line per shard directory saying when the agent should open it. Commit it.
3. Call the Workflow tool with `wait: true`, `script` set to the exact script below, unmodified, `maxConcurrent` set to the number of shards, and `args` set to `{ "memoryDir": "<absolute $MEMORY_DIR>", "corpus": "{{corpus}}", "shards": [{ "key": "<shard-key>", "dir": "<memory directory for this shard>", "description": "<what tasks it covers>", "ids": ["<trajectory id>", ...] }, ...] }`.
4. After the workflow completes, run `git status` in `$MEMORY_DIR`. If a failed worker left uncommitted files, commit them as they are. Then finish. Do not launch any other workers and do not edit memory beyond `MEMORY.md`.

```js
export const meta = {
  name: 'static-dream-workers',
  description: 'One worker per shard studies its trajectories, writes and commits memory, then stops',
  phases: [{ title: 'Workers', detail: 'each shard worker writes deferred memory and skills, and commits' }],
}

const SKILLS = ['maintaining-core-memory', 'maintaining-deferred-memory', 'creating-skills']
const TIMEOUT = 2 * 60 * 60 * 1000
const { memoryDir, corpus, shards } = args

function workerPrompt(s) {
  return `You are a memory-writing worker. A future agent will solve tasks like the ones in the past trajectories below. Study them, work out what made attempts pass or fail, and write those learnings into the agent's memory so it performs better next time. Quality matters more than volume.

Shard: ${s.key}: ${s.description}
Trajectories (${s.ids.length}): ${s.ids.map(id => `${corpus}/${id}.json or .jsonl`).join(', ')}
Files come in several harness formats; each includes the task, the attempt, and its outcome. Write throwaway scripts to extract what matters instead of reading large files linearly.

Memory repository: ${memoryDir}
You own only:
- ${s.dir}/ : deferred memory for this shard, including ${s.dir}/MEMORY.md, a frontmatter-free index with one line per file saying when to open it.
- New skills you create under skills/. Choose names that do not already exist there.
Do not edit root files or anything else.

Write task-specific knowledge (the correct reading of the spec, environment facts, what the verifier checks, approaches that passed and that failed) as deferred memory, and reusable procedures as skills. Follow the memory skills you have loaded for file format. Memory files contain no trajectory IDs, model names, or run stories.

Commit your own work: stage only your paths (never git add -A), with a commit message whose subject names the learning and whose body gives the reason and the supporting trajectory IDs. If git reports index.lock, retry after a few seconds. Before you finish, git status must show none of your paths modified or untracked.

Reply with 3-5 lines: files and skills written, and commit hashes.`
}

async function runWorker(s) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await agent(workerPrompt(s), { label: attempt === 1 ? s.key : `${s.key}-retry`, phase: 'Workers', skills: SKILLS, timeoutMs: TIMEOUT, effort: 'high' })
      return { key: s.key, ok: true, summary: String(result).slice(0, 1500) }
    } catch (err) {
      log(`FAILED ${s.key} (attempt ${attempt}): ${String((err && err.message) || err).slice(0, 300)}`)
      if (attempt === 2) return { key: s.key, ok: false, error: String((err && err.message) || err) }
    }
  }
}

phase('Workers')
return await Promise.all(shards.map(runWorker))
```
