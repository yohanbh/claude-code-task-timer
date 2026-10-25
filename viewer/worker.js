// Runs scan.js off the extension host's main thread. Its reads are synchronous, each one over
// /mnt/c takes milliseconds, and the extension host is shared by every extension, the Claude
// panel included, so they must not run there.
//
// In:  {active}  whether the tree is visible; the index is only refreshed while it is
//      {open}    a transcript file to stream, from the start
//      {close}   stop streaming it
// Out: {sessions}       the whole tree, whenever it changed or while anything is running
//      {file, entries}  transcript entries added since the last message for that file
//      {error}          a failed tick, for the extension host log

const { parentPort } = require("worker_threads");
const scan = require("./scan");

const index = new scan.Index();
const transcripts = new Map(); // file -> Tail
let active = false;
let wasLive = false;

function tick() {
  try {
    if (active) {
      const now = Date.now();
      const changed = index.refresh(now);
      const sessions = index.view(now);
      // While anything runs its elapsed time changes every second, and one more update after
      // that shows it finished.
      const live = sessions.some((s) => s.children.some((c) => c.state === "running"));
      if (changed || live || wasLive) parentPort.postMessage({ sessions });
      wasLive = live;
    }
    for (const [file, tail] of transcripts) {
      const entries = tail.read().flatMap(scan.entries);
      if (entries.length) parentPort.postMessage({ file, entries });
    }
  } catch (e) {
    parentPort.postMessage({ error: String((e && e.stack) || e) });
  }
}

parentPort.on("message", (m) => {
  if ("active" in m) active = m.active;
  if (m.open) transcripts.set(m.open, new scan.Tail(m.open));
  if (m.close) transcripts.delete(m.close);
  tick();
});
setInterval(tick, 1000);
