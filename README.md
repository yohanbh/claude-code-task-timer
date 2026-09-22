# claude-code-task-timer

Turn timers for the **Claude Code for VS Code** panel. The extension's
`showTurnDuration` setting only renders in the terminal UI, so the panel shows
nothing. This adds it.

Not affiliated with or endorsed by Anthropic. It patches a proprietary extension in
place on your own machine.

## What it adds

- `Working for 1m 2s` next to the spinner while a turn runs.
- `Worked for 5m 52s` under every finished turn in the history.
- A hover tooltip on each message showing when it was sent.

A message typed mid-turn does not split the timer, and reloading the window mid-turn
does not reset it — the running turn's start is recovered from the transcript.

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

`PATCHES` holds one entry per edit: a regex `anchor` that must match once, a `replace`
that rewrites it, and optional `prepend`ed code. The patches wrap the panel's own render
function and read its existing state. They never write to the message array, which
carries index bookkeeping, so everything added is display-only.

## License

MIT, see `LICENSE`. Covers this script only. It contains no Anthropic code — it ships
regexes that locate code in an extension you already have installed. The Claude Code
extension is proprietary (© Anthropic PBC) and is not included or redistributed here.
