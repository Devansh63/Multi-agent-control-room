# Setting up the bullpen

This turns the floor from a simulation into six real Claude Code sessions you
can point at a project, watch, and interrupt.

## Before you start

| You need | Check with | Notes |
| --- | --- | --- |
| Node 18+ | `node --version` | no npm install, there are no dependencies |
| Claude Code, logged in | `claude --version` then `claude -p "say hi"` | if that prints a reply, your subscription is wired up |
| A project to point it at | | ideally one with clean `git status` — see the warnings below |

Workers run through the `claude` CLI, so **they use the subscription already
logged in on your machine.** No API key, no separate billing. The one thing that
would change that is `--bare`, which this deliberately never passes.

## The prompt

Clone the repo, open Claude Code **in the project you want worked on**, and paste
this:

```
I've cloned https://github.com/Devansh63/agent-bullpen (tell me if you can't find
it and I'll give you the path). Get it running against this project.

1. Check prerequisites first and stop if anything is missing: `node --version`
   (needs 18+), `claude --version`, and confirm `claude -p "reply with OK"`
   actually returns something.
2. Read the bullpen's README.md and SETUP.md so you know what you're starting.
3. Start the orchestrator against THIS project, with three desks rather than
   six so we don't hit rate limits on the first run:
      node <path-to>/agent-bullpen/server/orchestrator.mjs --repo "$(pwd)" --desks 3
   Run it in the background, then tell me the URL it printed.
4. If it fails, read the server output and diagnose. The usual causes are:
   `claude` not on PATH, something already listening on port 4477 (use --port),
   or a Claude Code version that rejects one of the flags. If a flag is
   rejected, tell me which one and check its current name at
   https://code.claude.com/docs/en/cli-reference instead of guessing.
5. Once it's up, confirm the page loads and the desks show as empty, then stop
   and hand back to me. I'll assign the work from the browser.

Don't edit anything in this project. You're only starting a tool that will
later run other agents here.
```

Or just do it yourself:

```sh
node /path/to/agent-bullpen/server/orchestrator.mjs --repo "$(pwd)" --desks 3
# then open http://localhost:4477
```

### Flags

| Flag | Default | |
| --- | --- | --- |
| `--repo` | current directory | the project the agents work in |
| `--desks` | `6` | how many can run at once |
| `--model` | `sonnet` | the workers |
| `--manager-model` | `opus` | the planner |
| `--port` | `4477` | |
| `--ask-timeout` | `900000` | ms before an unanswered hand-raise is denied |

## Using it

**One desk, one task.** Type into *Assign to one desk*, pick a desk, hit Assign.
That desk's character starts working and its session log fills the inspector.
Assign to a busy desk and it queues behind what's already there. A desk keeps
its conversation between tasks, so a follow-up like "now add tests for that"
lands on an agent that remembers.

**The manager.** Type a project into *Give the manager a project* and hit Plan
it. The manager explores the repo read-only and returns a split. Nothing runs
until you press Dispatch, and you can reassign any subtask to a different desk
first. If the split looks wrong, that's the cheapest possible moment to find out.

**Raised hands are real.** When a worker tries something that needs permission,
it stands up, and that session is genuinely blocked until you click Approve or
Deny. This runs through a `PermissionRequest` hook passed to workers with
`--settings`, so your own `~/.claude/settings.json` is never touched.

### Writing briefs that work

Each desk is a *fresh* Claude Code session. It has not read your conversation,
doesn't know what the other desks are doing, and starts with an empty context.
A brief that works standing alone gets good work; a brief that assumes shared
context gets confident nonsense.

- **Bad:** "fix the bug we talked about"
- **Bad:** "refactor the auth stuff"
- **Good:** "In `api/src/auth/middleware.ts`, `requireSession` throws when the
  cookie is missing instead of returning 401. Make it return 401 with the same
  JSON error shape the other handlers in that folder use, and add a test in
  `api/test/auth.test.ts`."

The manager is prompted to write briefs this way, which is most of what it's for.

## Warnings worth reading

**Concurrency will hit your rate limits.** Six agents on one subscription is a
lot of simultaneous load. Start with `--desks 3`. If you see retry events on the
floor, that's the limiter, not a bug — use fewer desks.

**All desks share one working tree.** They are not sandboxed from each other. Two
agents told to edit the same file will clobber each other's work. The manager is
instructed to partition by file and to return fewer subtasks rather than
overlapping ones, but it is a language model, not a lock. **Commit or stash
before you dispatch**, and run this on a branch. Reviewing six agents' worth of
changes is much easier when `git diff` is the only thing you have to trust.

**It is a local tool, not a hosted one.** The server binds to `127.0.0.1` and
sends no CORS headers, so only the page it serves itself can drive it. Don't put
it on a public interface — anything that can reach the port can run agents in
your repo.

**What's been tested.** The orchestrator, the event parsing, the manager's
structured output, and the full permission round trip were all verified against
a stub `claude` binary. They have *not* yet been run against a real Claude Code
install. First run may well surface a flag or an event shape that needs
adjusting; the server prints everything it spawns, so the output will say which.
