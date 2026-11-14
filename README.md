# claude-code-task-timer

Turn timers for the **Claude Code for VS Code** panel. The extension's
`showTurnDuration` setting only renders in the terminal UI, so the panel shows
nothing. This adds it.

Not affiliated with or endorsed by Anthropic. It patches a proprietary extension in
place on your own machine.

![Turn duration in the Claude Code panel](docs/both.png)

## What it adds

- `Working for 1m 2s` next to the spinner while a turn runs.
- `Worked for 5m 52s · 12k out · 1.4M total` under every finished turn in the history:
  output tokens, and everything processed (input, cache reads and writes, output), for the
  main agent and its subagents. Turns past an hour read `1h 2m 3s`.
- A hover tooltip on each message showing when it was sent.
- Workflow-tool agents (ultracode, dynamic workflows) in the panel's **Agent map**, the
  agents pill in the input footer. Each run shows as an agent with its agents under it,
  with state, time, tokens and model; open one for its prompt, result and live transcript.
  Natively the map lists only Agent-tool subagents, and a workflow run is one background
  task with nothing per agent.
- Background tasks in the agents pill: `1 task`, or `2 agents · 1 task`, with the dot lit
  while one runs. Natively the pill counts agents only and hides without any, so a shell
  running in the background looks like nothing is happening. The map already lists these
  tasks, so the click needs nothing.
- The context-usage ring in the input footer, always, drawn to the real percentage.
  Natively it appears only once half the context is used and has three fixed shapes, so
  anything under 62.5% would draw half full. It stays hidden until the session's first
  reply finishes, since the context window size is unknown before then. Clicking it opens
  the same "Context usage" breakdown as `/context` instead of compacting.

A message typed mid-turn does not split the timer, and reloading the window mid-turn
does not reset it — the running turn's start is recovered from the transcript.

A background task reporting back (a `run_in_background` shell, a Monitor event) continues
the turn that started it rather than opening a new one: the clock picks up from that
turn's time, and the final label covers every stretch, tokens included. The wait itself
is not counted, so a dev server that exits hours later adds only the reply it gets.
Background subagents are different: the clock keeps running while they work.

## Usage

```sh
node patch-claude-timer.js            # apply
node patch-claude-timer.js --revert   # restore
```

Then run **Developer: Reload Window**.

Finds the extension in the remote/WSL server directory, a local install, and — from
WSL — Windows-side installs. Cursor, Windsurf, VSCodium and Insiders builds are not
covered; add their paths to `extensionRoots()` if you need them.

## Caveats

**Extension updates drop the patches.** New versions install into a new folder. When
the timer disappears, rerun the script.

**Tested against extension 2.1.278** (`linux-x64` and `win32-x64`). Patches are located
by regexes matching the shape of the minified code, so they survive some churn, but not
every release.

**It fails safely.** Each anchor must match exactly once or that patch prints `SKIPPED`
and is left out. The patched bundle is parsed before anything is written; if it does not
parse, nothing is written and the script exits non-zero. Every run rebuilds from a
pristine `index.js.orig`, so patches never stack.

When an anchor breaks, grep the new `webview/index.js` for the code described in the
comment above that anchor and update the regex.

## How it works

Two files. `patch-claude-timer.js` finds the installs and rewrites the bundle;
`panel-helper.js` is the code injected into the panel, kept separate so it reads as
JavaScript rather than one long string.

`PATCHES` holds one entry per edit: a regex `anchor` that must match once (or a set
`count` of times), a `replace` that rewrites it, and optional `prepend`ed code. The
patches wrap the panel's own render function and read its existing state. They never
write to the message array, which carries index bookkeeping, so everything added is
display-only.

Workflow agents come from the CLI's `task_progress` frames, whose `workflow_progress`
lists a run's agents; the panel ignores it, the helper keeps it (and in localStorage, so a
reload keeps finished runs). The map's display reads go through the helper, which adds
those agents to a copy; the panel's own agent state is never written. Their transcripts
load through the panel's existing transcript request, which already finds workflow
agents' files. Runs the panel never saw, such as those from before it was opened, are not
shown.

## Subagent viewer

`viewer/` is a separate, small VS Code extension that adds a **Claude Subagents** view to
the Explorer. It shows every subagent of the recent Claude Code sessions, including the
agents of Workflow-tool runs (ultracode, dynamic workflows), which the panel never shows.

- A tree of session → workflow run → phase → agent, with plain Agent-tool subagents
  alongside the runs. Each agent shows its state, elapsed time, tokens and last tool,
  updated every second while anything runs.
- Clicking an agent opens its transcript in a tab that follows along live: prompt, the
  agent's text, and each tool call with its input and result. Images are left out.

```sh
cd viewer
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
code --install-extension claude-subagent-viewer-0.2.0.vsix
```

**Pop out the map.** `Claude: Pop Out Map` (or the button on the Claude Subagents view)
opens [lot-map](https://github.com/alexeyw/lot-map)'s live map of the newest session in a
window of its own, for a second monitor. It is drawn by lot-map's own code, copied into
`viewer/map/` by `node viewer/build-map.js <lot-map checkout>`, and fed from the
transcripts instead of the plugin's hooks. So it lacks what only hooks see: a hook's
refusal is read from the refused call's error, and the context ring is the latest
request's size over `claudeMap.contextWindow` (default 500k tokens). When another session
becomes the newest, the map moves to it once the one shown has been quiet for 15 s (it
looks every 10 s, so within about 25 s).

**Agent map.** `Claude: Open Agent Map` (the other button on the view) opens
[agent map](https://github.com/yohanbh/agentmap), a terminal version that covers every
session at once, in a window of its own. Install it from that repo first.

Drag the view next to the Claude panel to watch both. From WSL it reads the WSL and the
Windows transcripts; on Windows it reads the Windows ones and those of running WSL distros.

It patches nothing: it only reads the transcripts under `~/.claude/projects`, so Claude
Code updates do not drop it. It reads them in a worker thread, so a slow `/mnt/c` never
stalls the extension host the Claude panel shares. `node viewer/scan.js` prints the same
index in the terminal.

**What it covers.** Sessions whose transcript changed in the last 12 hours, newest 8.
Figures for a running agent come from its transcript and match the run summary Claude
writes when a run ends. Tokens are the size of the agent's latest request, as in that
summary. An agent with no sign of finishing and no writes for 15 minutes shows as
inactive, because an interrupted agent leaves no marker.

**Next to the panel's Agent map.** The panel's **Agent map** (the agents pill in the
input footer) lists Agent-tool subagents, and with the patches above, workflow agents too.
This view also covers other sessions, runs from before the panel was opened, and agents'
tool calls in full.

## License

MIT, see `LICENSE`. Covers this script only. It contains no Anthropic code — it ships
regexes that locate code in an extension you already have installed. The Claude Code
extension is proprietary (© Anthropic PBC) and is not included or redistributed here.
