You are responsible for rewriting an agent's context stored in `$MEMORY_DIR`.
The agent's past trajectories are provided in `{{corpus}}`. Memory-writing workers will extract learnings from them; your job is only to shard the trajectories and run the workflow below.

1. Split the trajectories into 15–25 shards of related tasks, using the task statements. Every trajectory belongs to exactly one shard; keep shard sizes roughly balanced. With fewer related-task groups than that, use fewer shards: never split one task across shards and never create an empty shard. Do not analyze outcomes yourself.
2. Write `$MEMORY_DIR/MEMORY.md`: a short index with one line per shard directory saying when the agent should open it. Commit it.
3. Call the Workflow tool with `wait: true`, `script` set to the exact script below, unmodified, `maxConcurrent` set to the number of shards, and `args` set to `{ "memoryDir": "<absolute $MEMORY_DIR>", "corpus": "{{corpus}}", "shards": [{ "key": "<shard-key>", "dir": "<memory directory for this shard>", "description": "<what tasks it covers>", "ids": ["<trajectory id>", ...] }, ...] }`.
4. The workflow gives each worker its own git worktree and merges each worker's branch back into `$MEMORY_DIR` when it finishes. If it reports `unmerged` branches, merge each one yourself, resolving conflicts by keeping both sides (rename a colliding skill), then delete the branch. Then finish. Do not launch any other workers and do not edit memory beyond `MEMORY.md` and those merges.

```js
export const meta = {
  name: 'static-dream-workers',
  description: 'One worker per shard studies its trajectories and commits memory in its own worktree; branches merge back into main',
  phases: [{ title: 'Workers', detail: 'each shard worker writes deferred memory and skills in its own worktree, then its branch merges' }],
}

const SKILLS = ['maintaining-core-memory', 'maintaining-deferred-memory', 'creating-skills']
const TIMEOUT = 2 * 60 * 60 * 1000
const { memoryDir, corpus } = args
// Shard dirs are relative to the repository; empty shards get no worker.
const shards = args.shards
  .filter(s => s.ids && s.ids.length > 0)
  .map(s => ({ ...s, dir: String(s.dir).replace(memoryDir.replace(/\/+$/, ''), '').replace(/^\/+|\/+$/g, '') }))
const RUN = Date.now().toString(36)
const WORKTREES = memoryDir.replace(/\/+$/, '').replace(/[^/]+$/, 'memory-worktrees')
const q = p => `'${String(p).replace(/'/g, `'\\''`)}'`
// The planner's shell tool depends on its toolset: Bash, or exec_command (which reports exit codes in text).
async function sh(command) {
  if (tools.Bash) return tools.Bash({ command, description: 'Dream worktree git', timeout: 120000 })
  const out = String(await tools.exec_command({ cmd: command, yield_time_ms: 30000 }))
  if (!/Process exited with code 0\b/.test(out)) throw new Error(out.slice(-600))
  return out
}
const git = (cwd, cmd) => sh(`git -C ${q(cwd)} ${cmd}`)
let mergeChain = Promise.resolve()
const branchOf = (s, i) => `dream/${RUN}/${i}-${s.key.replace(/[^A-Za-z0-9._-]/g, '-')}`
const worktreeOf = i => `${WORKTREES}/dream-${RUN}-${i}`

function workerPrompt(s, worktree) {
  return `You are a memory-writing worker. A future agent will solve tasks like the ones in the past trajectories below. Study them, work out what made attempts pass or fail, and write those learnings into the agent's memory so it performs better next time. Quality matters more than volume.

Shard: ${s.key}: ${s.description}
Trajectories (${s.ids.length}): ${s.ids.map(id => `${corpus}/${id}.json or .jsonl`).join(', ')}
Files come in several harness formats; each includes the task, the attempt, and its outcome. Write throwaway scripts to extract what matters instead of reading large files linearly. Learn only from these trajectories: do not search the filesystem for other trajectories, transcripts, memory, or task material.

Memory repository: ${worktree} (your own git worktree on branch ${s.branch}; change into it first, and write and commit only here)
You own only:
- ${s.dir}/ : deferred memory for this shard, including ${s.dir}/MEMORY.md, a frontmatter-free index with one line per file saying when to open it.
- New skills you create under skills/. Choose names that do not already exist there.
Do not edit root files or anything else.

Write task-specific knowledge (the correct reading of the spec, environment facts, what the verifier checks, approaches that passed and that failed) as deferred memory, and reusable procedures as skills. Follow the memory skills you have loaded for file format. Memory files contain no trajectory IDs, model names, or run stories.

Commit your work in your worktree, with a commit message whose subject names the learning and whose body gives the reason and the supporting trajectory IDs. Do not push, merge, or switch branches; your branch is merged for you after you finish. Before you finish, git status must be clean.

Reply with 3-5 lines: files and skills written, and commit hashes.`
}

async function runWorker(s, i) {
  s.branch = branchOf(s, i)
  const worktree = worktreeOf(i)
  let outcome
  for (let attempt = 1; attempt <= 2 && !(outcome && outcome.ok); attempt++) {
    try {
      const result = await agent(workerPrompt(s, worktree), { label: attempt === 1 ? s.key : `${s.key}-retry`, phase: 'Workers', skills: SKILLS, timeoutMs: TIMEOUT, effort: 'high' })
      outcome = { key: s.key, ok: true, summary: String(result).slice(0, 1500) }
    } catch (err) {
      log(`FAILED ${s.key} (attempt ${attempt}): ${String((err && err.message) || err).slice(0, 300)}`)
      outcome = { key: s.key, ok: false, error: String((err && err.message) || err) }
    }
  }
  // Keep whatever a failed worker wrote, then merge its branch; merges run one at a time.
  await git(worktree, `add -A && { git -C ${q(worktree)} diff --cached --quiet || git -C ${q(worktree)} commit -q -m ${q(`dream: uncommitted work from ${s.key}`)}; }`)
    .catch(err => log(`LEFTOVERS ${s.key}: ${String((err && err.message) || err).slice(0, 300)}`))
  const merge = mergeChain.then(async () => {
    try {
      await git(memoryDir, `merge -q --no-ff -m ${q(`dream: merge ${s.key}`)} ${q(s.branch)}`)
    } catch (err) {
      await git(memoryDir, 'merge --abort').catch(() => {})
      log(`UNMERGED ${s.key}: ${s.branch}: ${String((err && err.message) || err).slice(0, 300)}`)
      await git(memoryDir, `worktree remove --force ${q(worktree)}`).catch(() => {})
      return { merged: false, unmerged: s.branch }
    }
    await git(memoryDir, `worktree remove --force ${q(worktree)} && git -C ${q(memoryDir)} branch -D ${q(s.branch)}`)
      .catch(err => log(`CLEANUP ${s.key}: ${String((err && err.message) || err).slice(0, 300)}`))
    return { merged: true }
  })
  mergeChain = merge
  return { ...outcome, ...(await merge) }
}

phase('Workers')
// Create every worktree before any worker starts; git serializes worktree creation.
for (const [i, s] of shards.entries()) {
  await git(memoryDir, `worktree add -q -b ${q(branchOf(s, i))} ${q(worktreeOf(i))} HEAD`)
}
return await Promise.all(shards.map(runWorker))
```
