#!/usr/bin/env node
// Indexes Claude Code subagents from their transcripts on disk: plain Agent-tool subagents, and
// the agents of Workflow-tool runs, which the panel never shows. extension.js draws this index;
// run it on its own to check it against live data:
//
//   node viewer/scan.js            recent sessions under every projects root found
//   node viewer/scan.js <root>...  only these projects roots (folders like ~/.claude/projects)
//
// It only reads. The file formats are described in HANDOFF-subagent-viewer.md.

const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process = require("child_process");

// Sessions whose main transcript changed within this window are indexed, newest first.
const RECENT_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;
// An interrupted agent leaves no completion marker, so an unfinished agent whose transcript has
// not changed for this long is shown as inactive instead of running forever.
const INACTIVE_MS = 15 * 60 * 1000;
// Tool inputs and results are cut to this many characters in the transcript view. Results can
// be whole files, and the view only needs enough to follow along.
const CLIP = 4000;

const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const stat = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// Every place transcripts can live: this user's home, plus the other side of WSL. From WSL that
// is each Windows user's home under /mnt/c; from Windows it is each home in each running distro.
// A stopped distro is left alone, since reading its files would boot it.
function projectRoots() {
  const homes = [os.homedir()];
  if (fs.existsSync("/mnt/c/Users")) {
    homes.push(...list("/mnt/c/Users").map((u) => path.join("/mnt/c/Users", u)));
  }
  if (process.platform === "win32") {
    for (const distro of runningDistros()) {
      const home = `\\\\wsl.localhost\\${distro}\\home`;
      homes.push(...list(home).map((u) => path.join(home, u)));
    }
  }
  const roots = homes.map((h) => path.join(h, ".claude", "projects"));
  return [...new Set(roots)].filter((r) => stat(r)?.isDirectory());
}

function runningDistros() {
  try {
    const out = child_process.execFileSync("wsl.exe", ["-l", "-q", "--running"], { timeout: 3000 });
    // wsl.exe writes UTF-16.
    return out.toString("utf16le").replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Reads a JSONL file that is appended to while we watch it. It keeps a byte offset so each call
// parses only the lines added since the last one, and holds back a half-written last line until
// its newline lands. Splitting on the newline byte is safe: it never occurs inside a multi-byte
// UTF-8 character.
class Tail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
  }

  read(size = stat(this.file)?.size ?? -1) {
    if (size < 0) return [];
    if (size < this.offset) {
      // The file was replaced; start over.
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    let n;
    let fd;
    try {
      fd = fs.openSync(this.file, "r");
      n = fs.readSync(fd, buf, 0, buf.length, this.offset);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    this.offset += n;
    const data = Buffer.concat([this.rest, buf.subarray(0, n)]);
    const end = data.lastIndexOf(10) + 1;
    // Copied, so a few held-back bytes do not keep a whole 10 MB read alive.
    this.rest = Buffer.from(data.subarray(end));
    const lines = [];
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {}
    }
    return lines;
  }
}

// A one-line description of a tool call: its own description when it has one, else its main input.
function toolSummary(input) {
  const i = input || {};
  const s = i.description || i.command || i.file_path || i.pattern || i.url || i.query || i.prompt || "";
  return String(s).replace(/\s+/g, " ").trim().slice(0, 120);
}

function newAgent(id, file) {
  return {
    id,
    file,
    tail: new Tail(file),
    label: "",
    phase: "",
    agentType: "",
    model: "",
    start: 0, // first and newest transcript timestamps, epoch ms
    last: 0,
    mtime: 0, // transcript file mtime, for spotting interrupted agents
    toolCalls: 0,
    lastTool: "",
    tokens: 0,
    ended: false, // the transcript shows the agent finishing
    result: undefined, // workflow agents: the value the journal recorded when the agent finished
    summary: null, // workflow agents: this agent's entry in the run summary, once the run has ended
  };
}

// agent-<id>.meta.json is written when the agent starts.
function readMeta(a) {
  const meta = readJson(a.file.replace(/\.jsonl$/, ".meta.json")) || {};
  a.label = a.label || meta.description || "";
  a.phase = a.phase || meta.workflowPhase || "";
  a.agentType = meta.agentType || "";
  a.model = a.model || meta.model || "";
}

function applyLine(a, l) {
  const ts = Date.parse(l.timestamp);
  if (ts) {
    a.start = a.start || ts;
    a.last = ts;
  }
  if (l.type === "assistant") {
    const m = l.message || {};
    // Tokens as the run summary counts them: the size of the latest request's context. Summing
    // usage over the transcript instead counts every cached read again and runs into millions.
    const u = m.usage;
    if (u) a.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (m.model && !m.model.startsWith("<")) a.model = m.model;
    // How an agent finishes: a text reply that ends its turn, a SubagentHandback call (plain
    // agents), or a StructuredOutput call (workflow agents with a schema). Anything else written
    // afterwards means it carried on, for example after a follow-up message.
    let ended = m.stop_reason === "end_turn";
    for (const b of m.content || []) {
      if (b.type !== "tool_use") continue;
      a.toolCalls++;
      a.lastTool = [b.name, toolSummary(b.input)].filter(Boolean).join(": ");
      if (b.name === "SubagentHandback" || b.name === "StructuredOutput") ended = true;
    }
    a.ended = ended;
  } else if (l.type === "attachment" && l.attachment?.type === "structured_output") {
    a.ended = true;
  }
}

// A finished or abandoned agent rarely writes again, so once read it is only re-checked on full
// passes. Each stat over /mnt/c costs a millisecond or more, and a session can have a hundred agents.
const settled = (a, now) => a.tail.offset > 0 && (a.ended || a.result !== undefined || now - a.mtime > INACTIVE_MS);

function readAgent(a) {
  const st = stat(a.file);
  if (!st) return false;
  a.mtime = st.mtimeMs;
  const lines = a.tail.read(st.size);
  for (const l of lines) applyLine(a, l);
  return lines.length > 0;
}

// What is shown for an agent: the run summary's figures once the run has ended, otherwise
// figures derived from the transcript, which match the summary's.
function agentView(a, now) {
  const p = a.summary;
  let state;
  if (p) state = p.state;
  else if (a.ended || a.result !== undefined) state = "done";
  else state = now - (a.mtime || now) > INACTIVE_MS ? "inactive" : "running";
  return {
    kind: "agent",
    id: a.id,
    file: a.file,
    label: a.label || a.id,
    phase: a.phase,
    agentType: a.agentType,
    model: (p && p.model) || a.model,
    state,
    start: (p && p.startedAt) || a.start,
    elapsedMs: p ? p.durationMs : a.start ? (state === "running" ? now : a.last) - a.start : 0,
    tokens: p ? p.tokens : a.tokens,
    toolCalls: p ? p.toolCalls : a.toolCalls,
    lastTool: p ? [p.lastToolName, p.lastToolSummary].filter(Boolean).join(": ") : a.lastTool,
  };
}

// The script is saved as <name>-<runId>.js under workflows/scripts in the session's folder, but
// inside the project folder for wherever Claude was working at launch. That is not always the
// project folder the session lives in, so the sibling projects are searched too.
function scriptName(s, runId) {
  for (const project of [s.project, ...list(s.root)]) {
    const f = list(path.join(s.root, project, s.id, "workflows", "scripts")).find((f) => f.endsWith(`-${runId}.js`));
    if (f) return f.slice(0, -(runId.length + 4));
  }
  return "";
}

function runAgent(run, id) {
  let a = run.agents.get(id);
  if (!a) {
    a = newAgent(id, path.join(run.dir, `agent-${id}.jsonl`));
    a.mtime = Date.now(); // the journal can name an agent before its transcript exists
    readMeta(a);
    run.agents.set(id, a);
  }
  return a;
}

function refreshRun(s, run, now, full) {
  let changed = false;
  const journal = stat(run.journal.file);
  run.mtime = Math.max(run.mtime, journal?.mtimeMs || 0);
  // The journal: "started" names an agent and its phase, "result" means it finished.
  for (const j of run.journal.read(journal?.size ?? -1)) {
    if (!j.agentId) continue;
    const a = runAgent(run, j.agentId);
    if (j.type === "started") {
      a.label = j.label || a.label;
      a.phase = j.phase || a.phase;
    } else if (j.type === "result") {
      a.result = j.result;
    }
    changed = true;
  }
  // The journal names each agent as it starts, so only full passes look for strays.
  for (const f of full ? list(run.dir) : []) {
    const m = /^agent-(\w+)\.jsonl$/.exec(f);
    if (m && !run.agents.has(m[1])) {
      runAgent(run, m[1]);
      changed = true;
    }
  }
  // The run summary is written only when the run ends. It has everything, so from then on the
  // transcripts no longer need reading, and the caller stops refreshing the run. Until then each
  // look is a failed open, so only full passes look.
  const sum = full && readJson(path.join(s.dir, "workflows", `${run.id}.json`));
  if (sum) {
    run.summary = sum;
    run.name = sum.workflowName || run.name;
    for (const p of sum.workflowProgress || []) {
      if (p.type !== "workflow_agent" || !p.agentId) continue;
      const a = runAgent(run, p.agentId);
      a.summary = p;
      a.label = a.label || p.label || "";
      a.phase = a.phase || p.phaseTitle || "";
    }
    return true;
  }
  for (const a of run.agents.values()) {
    if (!full && settled(a, now)) continue;
    changed = readAgent(a) || changed;
    run.mtime = Math.max(run.mtime, a.mtime);
  }
  return changed;
}

function runView(run, now) {
  const agents = [...run.agents.values()].map((a) => agentView(a, now));
  const sum = run.summary;
  let state;
  if (sum) state = sum.status || "done";
  else if (agents.some((a) => a.state === "running")) state = "running";
  // Between phases no agent is running, but the run is.
  else state = now - run.mtime > INACTIVE_MS ? "inactive" : "running";
  const start = (sum && sum.startTime) || Math.min(...agents.map((a) => a.start || Infinity));
  const phases = [...new Set(agents.map((a) => a.phase))];
  return {
    kind: "run",
    id: run.id,
    dir: run.dir,
    name: run.name || run.id,
    state,
    start: Number.isFinite(start) ? start : run.mtime,
    elapsedMs: sum ? sum.durationMs : Number.isFinite(start) ? (state === "running" ? now : run.mtime) - start : 0,
    tokens: agents.reduce((t, a) => t + (a.tokens || 0), 0),
    done: agents.filter((a) => a.state === "done").length,
    total: agents.length,
    // Phases get their own level only when there is more than one.
    children:
      phases.length > 1
        ? phases.map((title) => {
            const own = agents.filter((a) => a.phase === title);
            return {
              kind: "phase",
              id: `${run.dir}#${title}`,
              title: title || "(no phase)",
              running: own.filter((a) => a.state === "running").length,
              done: own.filter((a) => a.state === "done").length,
              total: own.length,
              children: own,
            };
          })
        : agents,
  };
}

function refreshSession(s, now, full) {
  let changed = false;
  const sub = path.join(s.dir, "subagents");
  // New agents and runs are looked for on full passes only; in between, only the known ones are read.
  for (const f of full ? list(sub) : []) {
    const m = /^agent-(\w+)\.jsonl$/.exec(f);
    if (!m || s.plain.has(m[1])) continue;
    const a = newAgent(m[1], path.join(sub, f));
    readMeta(a);
    s.plain.set(a.id, a);
    changed = true;
  }
  for (const a of s.plain.values()) {
    if (!full && settled(a, now)) continue;
    changed = readAgent(a) || changed;
  }
  for (const f of full ? list(path.join(sub, "workflows")) : []) {
    if (!f.startsWith("wf_") || s.runs.has(f)) continue;
    const dir = path.join(sub, "workflows", f);
    s.runs.set(f, { id: f, dir, journal: new Tail(path.join(dir, "journal.jsonl")), agents: new Map(), summary: null, name: scriptName(s, f), mtime: 0 });
    changed = true;
  }
  // A run with a summary has ended for good.
  for (const run of s.runs.values()) if (!run.summary) changed = refreshRun(s, run, now, full) || changed;
  return changed;
}

// "-home-yohanb-learning-claude-time" -> "learning-claude-time", "c--dev-Mods-Foo" -> "dev-Mods-Foo"
const projectName = (p) => p.replace(/^-home-[^-]+-/, "").replace(/^[A-Za-z]--/, "") || p;

class Index {
  // roots: projects folders to read; by default every one projectRoots() finds, looked up again
  // each minute.
  constructor(roots) {
    this.fixedRoots = roots;
    this.roots = roots || [];
    this.rootsAt = 0;
    this.foundAt = 0;
    this.walkedAt = 0;
    this.sessions = new Map(); // session folder -> session
  }

  // Brings the index up to date. Returns true when anything was read. Every 5 s it does a full
  // pass: it looks for new agents and re-checks agents that looked finished. Every 30 s it also
  // walks every project folder for new sessions, which over /mnt/c is thousands of slow stats.
  refresh(now = Date.now()) {
    let changed = false;
    if (!this.fixedRoots && now - this.rootsAt > 60000) {
      this.roots = projectRoots();
      this.rootsAt = now;
    }
    const full = now - this.foundAt > 5000;
    if (full) this.foundAt = now;
    if (full && now - this.walkedAt <= 30000) {
      for (const s of this.sessions.values()) s.mtime = stat(path.join(path.dirname(s.dir), `${s.id}.jsonl`))?.mtimeMs || s.mtime;
    } else if (full) {
      this.walkedAt = now;
      const found = this.recentSessions(now);
      const keep = new Set(found.map((s) => s.dir));
      for (const dir of this.sessions.keys()) {
        if (!keep.has(dir)) {
          this.sessions.delete(dir);
          changed = true;
        }
      }
      for (const s of found) {
        const old = this.sessions.get(s.dir);
        if (old) old.mtime = s.mtime;
        else {
          this.sessions.set(s.dir, { ...s, plain: new Map(), runs: new Map() });
          changed = true;
        }
      }
    }
    for (const s of this.sessions.values()) changed = refreshSession(s, now, full) || changed;
    return changed;
  }

  // The newest sessions that have subagents, by when their main transcript last changed.
  recentSessions(now) {
    const found = [];
    for (const root of this.roots) {
      for (const project of list(root)) {
        const pdir = path.join(root, project);
        for (const f of list(pdir)) {
          if (!f.endsWith(".jsonl")) continue;
          const id = f.slice(0, -6);
          const mtime = stat(path.join(pdir, f))?.mtimeMs || 0;
          if (now - mtime > RECENT_MS || !stat(path.join(pdir, id, "subagents"))) continue;
          found.push({ root, project, id, dir: path.join(pdir, id), mtime });
        }
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
  }

  // Sessions, newest first, each with its runs and plain agents, newest first.
  view(now = Date.now()) {
    return [...this.sessions.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .map((s) => {
        const children = [...[...s.runs.values()].map((r) => runView(r, now)), ...[...s.plain.values()].map((a) => agentView(a, now))];
        children.sort((a, b) => b.start - a.start);
        const agents = children.flatMap((c) => (c.kind === "run" ? c.children.flatMap((p) => (p.kind === "phase" ? p.children : [p])) : [c]));
        return {
          kind: "session",
          id: s.id,
          dir: s.dir,
          project: projectName(s.project),
          mtime: s.mtime,
          running: agents.filter((a) => a.state === "running").length,
          children,
        };
      })
      .filter((s) => s.children.length);
  }
}

// Turns one transcript line into what the transcript view draws. Thinking is skipped (it is
// stored empty), and so are images and the harness's own notes: meta lines and attachments other
// than the structured output a schema agent finishes with.
function entries(l) {
  const ts = l.timestamp;
  const clip = (s) => (s.length > CLIP ? s.slice(0, CLIP) + `\n… ${s.length - CLIP} more characters` : s);
  const out = [];
  if (l.type === "assistant") {
    for (const b of l.message?.content || []) {
      if (b.type === "text" && b.text.trim()) out.push({ kind: "text", ts, text: b.text });
      else if (b.type === "tool_use") {
        out.push({ kind: "tool", ts, id: b.id, name: b.name, summary: toolSummary(b.input), input: clip(JSON.stringify(b.input, null, 2)) });
      }
    }
  } else if (l.type === "user" && !l.isMeta) {
    const c = l.message?.content;
    if (typeof c === "string") out.push({ kind: "user", ts, text: c });
    else {
      for (const b of c || []) {
        if (b.type === "text") out.push({ kind: "user", ts, text: b.text });
        else if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content : (b.content || []).map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
          out.push({ kind: "result", ts, id: b.tool_use_id, error: !!b.is_error, text: clip(text) });
        }
      }
    }
  } else if (l.type === "attachment" && l.attachment?.type === "structured_output") {
    out.push({ kind: "output", ts, text: JSON.stringify(l.attachment.data, null, 2) });
  }
  return out;
}

// 65000 -> "1m 5s", 3723000 -> "1h 2m 3s" (the same as the panel timer)
const fmt = (ms) => {
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
};
// 950 -> "950", 12345 -> "12k", 1234567 -> "1.2M"
const num = (n) => {
  if (n < 1000) return String(n);
  const [d, u] = n < 999500 ? [1e3, "k"] : [1e6, "M"], v = n / d;
  return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + u;
};

module.exports = { Index, Tail, projectRoots, entries, fmt, num, INACTIVE_MS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const index = new Index(args.length ? args.map((a) => path.resolve(a)) : undefined);
  const now = Date.now();
  index.refresh(now);
  console.log(`roots: ${index.roots.join(", ") || "(none found)"}`);
  const agentLine = (a, indent) =>
    `${indent}${a.state.padEnd(9)} ${a.label}  ${fmt(a.elapsedMs)}  ${num(a.tokens)} tok  ${a.toolCalls} tools  ${a.lastTool}`;
  for (const s of index.view(now)) {
    console.log(`\n${s.project}  ${s.id.slice(0, 8)}  updated ${fmt(now - s.mtime)} ago  ${s.running} running`);
    for (const c of s.children) {
      if (c.kind === "agent") {
        console.log(agentLine(c, "  "));
        continue;
      }
      console.log(`  workflow ${c.name}  ${c.state}  ${c.done}/${c.total} done  ${fmt(c.elapsedMs)}  ${num(c.tokens)} tok`);
      for (const p of c.children) {
        if (p.kind === "agent") console.log(agentLine(p, "    "));
        else {
          console.log(`    ${p.title}`);
          for (const a of p.children) console.log(agentLine(a, "      "));
        }
      }
    }
  }
}
