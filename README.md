# Agent Bullpen

A pixel-art office floor for watching coding agents work. Every running session
is a character at a desk: the monitor glows green while it writes, cyan while it
reads, amber while a shell command runs. When an agent needs your approval it
stands up and raises its hand, and stays frozen there until you answer.

It runs two ways.

**As a demo** — open `index.html` in a browser. One file, no build, no
dependencies, no install. The floor runs on a simulator, so nothing it shows is
real: the tasks come from a hardcoded list. It's there to answer "would I
actually want to manage agents this way?"

**For real** — start the orchestrator, and each desk becomes a live Claude Code
session working in a project of yours, which you can assign tasks to, watch, and
interrupt.

```sh
git clone https://github.com/Devansh63/agent-bullpen.git
node agent-bullpen/server/orchestrator.mjs --repo "$(pwd)" --desks 3
# open http://localhost:4477
```

**[SETUP.md](SETUP.md)** has the prerequisites, a prompt you can paste straight
into Claude Code to get it running, and the warnings that matter — rate limits,
the shared working tree, and what hasn't been tested yet. Read it before you
point this at a repo you care about.

## Why a floor and not a list

A tab strip tells you an agent exists. It does not tell you that four of them are
fine and one has been sitting on a permission prompt for six minutes. Spatial
layout makes that a glance instead of a scan — which is the whole argument for
the format, and the reason the same idea keeps getting rebuilt.

## What you get

- **Six desks.** Agents walk in, take a free desk, and sit down.
- **State you can read from across the room.** Screen colour, posture, and a
  bubble over the head: typing, reading, running, thinking, error, done.
- **Per-desk task assignment.** Type a brief, pick a desk, hit Assign. A desk
  keeps its conversation between tasks, so follow-ups land on an agent that
  remembers what it just did.
- **A manager that delegates.** Give it a whole project; it explores the repo
  read-only and returns a split, with a self-contained brief per subtask.
  Nothing runs until you press Dispatch, and you can reassign any subtask first.
- **Raised hands that actually block.** A real permission request parks the
  worker until you click Approve or Deny.
- **Sub-agents.** When a worker spawns its own, it shows up in the log.
- **A roster list** carrying the same information as text, so the canvas isn't
  the only way to read the floor.

## Architecture

The office is a **view**. It holds no logic of its own about what an agent is
doing — every pixel it draws is a fold over one function:

```js
applyEvent({ ts, sessionId, type, tool, detail })
```

| type | what the floor does |
| --- | --- |
| `SessionStart` | a worker takes a desk and starts |
| `PreToolUse` | posture and screen colour switch to that tool's activity |
| `PostToolUse` | progress ticks forward |
| `PermissionRequest` | the worker stands, raises a hand, and blocks |
| `Notification` | red bubble, error state |
| `SubagentStart` / `SubagentStop` | a sub-agent arrives / leaves |
| `Stop` | violet check, task complete |

In demo mode a simulator produces that stream. In live mode the orchestrator
does, and the renderer cannot tell the difference — which is what made the
second mode a bridge rather than a rewrite.

### The pieces

```
index.html                  the floor. self-contained, simulated on its own
server/orchestrator.mjs     desks, sessions, task routing, SSE, the manager
server/live.js              injected at serve time; swaps the simulator for
                            the live stream and adds the task controls
hooks/permission-hook.mjs   PermissionRequest hook → the raised hand
```

**Workers.** Each desk runs `claude -p "<task>" --output-format stream-json`,
opened with `--session-id` and continued with `--resume`, so the desk has memory.
Output is newline-delimited JSON, folded into the event vocabulary above. It
shells out to the `claude` CLI rather than the API, so runs bill against the
subscription already logged in on the machine — `--bare` would break that, and is
never passed.

**The manager.** Runs with `--json-schema` against a read-only tool set
(`Read,Glob,Grep`) in `dontAsk` mode, so it physically cannot edit anything while
planning. It returns `{summary, subtasks[{title, brief, files}]}`, prompted hard
on the two constraints that actually break parallel agents: every brief must
stand alone, because workers share no context, and no two subtasks may touch the
same file, because they share one working tree.

**Permissions.** The orchestrator writes a settings file registering a
`PermissionRequest` hook and passes it to each worker with `--settings`, so your
global `~/.claude/settings.json` is untouched. The hook posts the request to the
orchestrator and polls until the click. If the orchestrator is unreachable it
denies with a clear reason rather than hanging or silently allowing.

**Rendering.** Canvas 2D at a fixed 320x200 internal resolution, scaled 4x with
`image-rendering: pixelated`. Characters are 12x16 cell maps — plain strings
where each letter is a palette role (`H` hair, `F` skin, `S` shirt, `P` pants) —
so restyling a character means editing a few strings, not swapping an asset pack.
Everything is depth-sorted by y so workers occlude desks correctly, with
nameplates and bubbles drawn in a final overlay pass.

## Prior art

A from-scratch take on a format several people have built:
[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (VS Code
extension, hooks + transcript fallback),
[AIOffice](https://www.christianfjung.com/aioffice) (Phaser 3 over real PTY
processes), and [agent-office](https://github.com/harishkotra/agent-office)
(agents that hire their own interns). The lineage goes back to Stanford's
*Generative Agents* — same pixel-town aesthetic, pointed at real work.

## License

MIT
