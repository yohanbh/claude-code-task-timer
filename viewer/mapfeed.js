// What the popped-out map is fed: the most recently active Claude Code session's transcripts,
// main loop and subagents, turned into small events. map/view.js replays them into lot-map's board.
// Runs in the worker (see worker.js), next to scan.js, and like it only reads.
//
// Run it on its own to see the events of the newest session:  node viewer/mapfeed.js

const fs = require("fs");
const path = require("path");
const { Tail, projectRoots } = require("./scan");

// Another session takes the map over only once the one shown has been quiet this long, so two
// sessions running side by side do not make it flip back and forth.
const SWITCH_AFTER_MS = 15000;
// How often a quiet session's map looks for a newer one.
const SEARCH_MS = 10000;
const CLIP = 2000;

const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

// Tool inputs go to the page only for classify(): command lines, paths, URLs. Long strings are cut.
const clip = (v) =>
  typeof v === "string" ? v.slice(0, CLIP) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)])) : v;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";

// A hook or the person refused the call. Seen only in the result's text.
const REFUSED = /hook.*(denied|blocked)|blocked by.*hook|doesn't want to proceed|permission to use .* (was|has been) denied/i;

// The parts of a tool's structured result that say it started background work (lot-map's taskOf).
const taskFields = (r) => {
  if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
  const { status, agentId, taskId, backgroundTaskId, timeoutMs } = r;
  return { status, agentId, taskId, backgroundTaskId, timeoutMs };
};

// One transcript line -> zero or more events. `a` is the subagent's id, undefined for the main loop.
function events(l, a) {
  const t = Date.parse(l.timestamp) || undefined;
  const out = [];
  const push = (e) => out.push({ t, ...(a ? { a } : {}), ...e });
  if (l.type === "assistant" && l.message) {
    const m = l.message;
    const u = m.usage || {};
    push({
      k: "step",
      id: m.id,
      model: m.model,
      stop: m.stop_reason,
      // A reply is written one content block per line, so its thinking can land long before its text or tool call.
      text: (m.content || []).some((c) => c.type === "text"),
      tok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
      tools: (m.content || []).filter((c) => c.type === "tool_use").map((c) => ({ id: c.id, name: c.name, input: clip(c.input || {}) })),
    });
  } else if (l.type === "user" && l.message && !l.isMeta) {
    const content = l.message.content;
    const results = Array.isArray(content) ? content.filter((c) => c.type === "tool_result") : [];
    for (const r of results) {
      const text = textOf(r.content);
      push({ k: "result", id: r.tool_use_id, err: r.is_error === true, block: r.is_error === true && REFUSED.test(text), hook: /hook/i.test(text), res: taskFields(l.toolUseResult) });
    }
    if (results.length) return out;
    const text = textOf(content);
    if (text.startsWith("[Request interrupted by user")) push({ k: "abort" });
    else if (text.trimStart().startsWith("<task-notification>")) push({ k: "notice", text: text.slice(0, 1000), turn: true });
    else if (text && !/^\s*<(local-command|command-name|command-message)/.test(text)) push({ k: "prompt" });
  } else if (l.type === "attachment" && l.attachment) {
    const at = l.attachment;
    if (at.type === "hook_additional_context") push({ k: "hookctx", start: at.hookEvent === "SessionStart" });
    else if (at.type === "hook_success" && at.hookEvent === "PreToolUse" && at.durationMs >= 400) push({ k: "hookslow", tool: String(at.hookName || "").split(":")[1] || "" });
    else if (at.type === "queued_command" && typeof at.prompt === "string" && at.prompt.includes("<task-notification>")) push({ k: "notice", text: at.prompt.slice(0, 1000) });
  } else if (l.type === "queue-operation" && typeof l.content === "string" && l.content.includes("<task-notification>")) {
    push({ k: "notice", text: l.content.slice(0, 1000) });
  } else if (l.type === "system" && l.subtype === "compact_boundary") {
    push({ k: "compact" });
  }
  return out;
}

class MapFeed {
  constructor(roots) {
    this.fixedRoots = roots;
    this.roots = roots || [];
    this.rootsAt = 0;
    this.lookedAt = 0;
    this.searchedAt = 0;
    this.session = null; // { file, dir, project, id }
    this.tails = new Map(); // file -> { tail, agent }
  }

  // The newest main transcript under every projects root.
  newest() {
    let best = null;
    for (const root of this.roots) {
      for (const project of list(root)) {
        const pdir = path.join(root, project);
        for (const f of list(pdir)) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(pdir, f);
          const at = mtime(file);
          if (!best || at > best.at) best = { file, dir: file.slice(0, -6), project, id: f.slice(0, -6), at };
        }
      }
    }
    return best;
  }

  // Every transcript of the session: the main one, plain subagents and workflow agents.
  files() {
    const { file, dir } = this.session;
    const found = [[file, undefined]];
    const sub = path.join(dir, "subagents");
    const agents = (d) => list(d).map((f) => /^agent-(\w+)\.jsonl$/.exec(f)).filter(Boolean).map((m) => [path.join(d, m[0]), m[1]]);
    found.push(...agents(sub));
    for (const wf of list(path.join(sub, "workflows"))) if (wf.startsWith("wf_")) found.push(...agents(path.join(sub, "workflows", wf)));
    return found;
  }

  // New events since the last call, in time order, and `session` when the map moved to another one
  // (the page then starts its board over).
  tick(now = Date.now()) {
    if (!this.fixedRoots && now - this.rootsAt > 60000) {
      this.roots = projectRoots();
      this.rootsAt = now;
    }
    let session;
    if (now - this.lookedAt > 2000) {
      this.lookedAt = now;
      // Every project under every root is searched only when another session could take over: none
      // is shown yet, or the one shown has gone quiet. Over /mnt/c the search is slow.
      const quiet = !this.session || now - mtime(this.session.file) > SWITCH_AFTER_MS;
      if (quiet && now - this.searchedAt > (this.session ? SEARCH_MS : 2000)) {
        this.searchedAt = now;
        const best = this.newest();
        if (best && best.file !== this.session?.file) {
          this.session = best;
          this.tails.clear();
          session = { project: best.project, id: best.id, file: best.file };
        }
      }
      if (this.session) for (const [file, agent] of this.files()) if (!this.tails.has(file)) this.tails.set(file, { tail: new Tail(file), agent });
    }
    const out = [];
    for (const { tail, agent } of this.tails.values()) for (const l of tail.read()) out.push(...events(l, agent));
    out.sort((x, y) => (x.t || 0) - (y.t || 0));
    // A subagent or workflow just started: list its transcripts on the next tick, not up to 2 s later.
    if (out.some((e) => e.k === "step" && e.tools.some((c) => c.name === "Agent" || c.name === "Workflow"))) this.lookedAt = 0;
    return { session, events: out };
  }
}

module.exports = { MapFeed, events };

if (require.main === module) {
  const { session, events: ev } = new MapFeed().tick();
  console.log(session);
  const kinds = {};
  for (const e of ev) kinds[e.k] = (kinds[e.k] || 0) + 1;
  console.log(kinds);
  console.log(ev.slice(-8).map((e) => JSON.stringify(e).slice(0, 200)).join("\n"));
}
