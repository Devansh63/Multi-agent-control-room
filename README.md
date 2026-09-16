# Agent Bullpen

A pixel-art office floor for watching coding agents work. Every running session
is a character at a desk: the monitor glows green while it writes, cyan while it
reads, amber while a shell command runs. When an agent needs your approval it
stands up and raises its hand, and stays frozen there until you answer.

One file, no build step, no dependencies. Open `index.html` in a browser.

```sh
git clone https://github.com/Devansh63/agent-bullpen.git
cd agent-bullpen
open index.html        # or: python3 -m http.server 8000
```

It ships with a simulator running, so the floor is alive on first open.

## Why a floor and not a list

A tab strip tells you an agent exists. It does not tell you that four of them are
fine and one has been sitting on a permission prompt for six minutes. Spatial
layout makes that a glance instead of a scan — which is the whole argument for
the format, and the reason the same idea keeps getting rebuilt.

## What you get

- **Six desks.** Agents walk in through the door, take a free desk, and sit down.
- **State you can read from across the room.** Screen colour, posture, and a
  bubble over the head: typing, reading, running, thinking, error, done.
- **Raised hands.** A `PermissionRequest` halts the agent and surfaces the actual
  command (`git push --force origin hotfix`) with Approve / Deny in the inspector.
- **Sub-agents.** A `Task` spawn walks in, takes a spare desk, and leaves when it
  reports back.
- **Per-agent session log**, a global ticker, and a roster list that carries the
  same information as text (so the canvas is not the only way to read the floor).
- **Controls:** pause, 1x/2x/4x, hire, send home.

## Architecture

The office is a **view**. It holds no logic of its own about what an agent is
doing — every pixel it draws is a fold over one function:

```js
applyEvent({ ts, sessionId, type, tool, detail })
```

`type` is one of:

| type | what the floor does |
| --- | --- |
| `SessionStart` | a worker walks in and takes a desk |
| `PreToolUse` | posture and screen colour switch to that tool's activity |
| `PostToolUse` | progress ticks forward |
| `PermissionRequest` | the worker stands, raises a hand, and blocks |
| `Notification` | red bubble, error state |
| `SubagentStart` / `SubagentStop` | an intern arrives / leaves |
| `Stop` | violet check, task complete |

Tool names map to activities through one table — `Read`/`Grep`/`Glob` read,
`Edit`/`Write` write, `Bash` runs, `WebSearch`/`WebFetch` search, `Task` thinks.
Teaching the floor a new tool is one line in `TOOL_ACT`.

Rendering is Canvas 2D at a fixed 320x200 internal resolution, scaled 4x with
`image-rendering: pixelated`. Characters are 12x16 cell maps — plain strings
where each letter is a palette role (`H` hair, `F` skin, `S` shirt, `P` pants)
— so restyling a character means editing a few strings, not swapping an asset
pack. Everything is depth-sorted by y so workers occlude desks correctly, with
nameplates and bubbles drawn in a final overlay pass.

## Wiring it to real sessions

Not built yet — but the seam is already there. `connectLive(url)` in
`index.html` opens a socket and feeds each message straight into `applyEvent`:

```js
connectLive('ws://localhost:4477');
```

What's missing is the bridge: a small local server that accepts events on one
side and broadcasts them to the page on the other, plus hooks in
`~/.claude/settings.json` that POST to it:

```json
{
  "hooks": {
    "PreToolUse":  [{ "hooks": [{ "type": "command", "command": "bullpen-hook" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "bullpen-hook" }] }],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "bullpen-hook" }] }]
  }
}
```

Hooks receive the event JSON on stdin, so `bullpen-hook` is close to a one-liner
that curls stdin at the bridge. The fallback path other projects use, when hooks
aren't available, is tailing the session transcripts under
`~/.claude/projects/*.jsonl`.

Delete the simulator (`nextStep`, `step`, and the boot loop at the bottom) once
real events are flowing.

## Prior art

This is a from-scratch take on a format several people have built:
[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (VS Code
extension, hooks + transcript fallback),
[AIOffice](https://www.christianfjung.com/aioffice) (Phaser 3 over real PTY
processes), and [agent-office](https://github.com/harishkotra/agent-office)
(agents that hire their own interns). The lineage goes back to Stanford's
*Generative Agents* — same pixel-town aesthetic, pointed at real work.

## License

MIT
