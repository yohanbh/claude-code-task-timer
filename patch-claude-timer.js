#!/usr/bin/env node
// Applies local patches to the Claude Code VS Code panel bundle (webview/index.js).
// Extension updates install into a new folder and drop them, so re-run after each one.
//
//   node patch-claude-timer.js            apply to every install found
//   node patch-claude-timer.js --revert   restore the original bundle
//
// Each run rebuilds from the pristine index.js.orig backup, so patches never stack.
// The injected code lives in panel-helper.js. See README.md for the rest.

const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process = require("child_process");

const MARKER = "/*cc-local-patches*/";

// The code injected into the panel bundle, kept in its own file so it reads as the
// JavaScript it is. It is prepended verbatim, so the file must stay self-contained and
// must not reference anything from this script.
const TIMER_HELPER = fs.readFileSync(path.join(__dirname, "panel-helper.js"), "utf8");

// One entry per change. `anchor` must match exactly once in the bundle (or exactly
// `count` times, when set); names there are minified and change every release, so
// match by shape and capture them. `prepend` (optional) is code added once to the
// top of the bundle; wrap it in try/catch so a bug in a patch can never stop the
// panel from loading.
const PATCHES = [
  {
    // Live "Working for 1m 2s" in the main chat's spinner row.
    name: "turn-timer",
    // let t0=$.visiblyBusy.value&&!$.permissionRequests.value.length,N5=F("div",{className:f0.spinnerRow,
    // (2.1.281 renamed busy to visiblyBusy here; the helper still subscribes to busy itself.)
    anchor: /let ([\w$]+)=([\w$]+)\.(busy|visiblyBusy)\.value&&!\2\.permissionRequests\.value\.length,([\w$]+)=([\w$]+)\("div",\{className:([\w$]+)\.spinnerRow,/g,
    replace: (_m, flag, session, busy, row, jsx, styles) =>
      `let ${flag}=(window.__ccTurnTimer&&window.__ccTurnTimer(${session}),${session}.${busy}.value)&&!${session}.permissionRequests.value.length,${row}=${jsx}("div",{"data-cc-timer":"1",className:${styles}.spinnerRow,`,
    prepend: TIMER_HELPER,
  },
  {
    // Hand the helper the JSX factory, so it can wrap a row in a tooltip element.
    // var B1=mL0,F=Mk1,R=Mk1;
    name: "turn-jsx",
    // The values must be identifiers: `var Z=0,X=0,Y=0;` elsewhere in the bundle matched too.
    anchor: /var ([\w$]+)=([A-Za-z_$][\w$]*),([\w$]+)=([A-Za-z_$][\w$]*),([\w$]+)=\4;/g,
    replace: (m, b1, mL0, F, Mk1, R) =>
      `${m}window.__ccJsx=${F};`,
  },
  {
    // Carry the host's isQueuedCommand flag onto the rendered row. The host sets it when it
    // rebuilds a prompt that was typed mid-turn from the transcript's queued_command
    // attachment, so it is the one marker that survives a reload. The row constructor
    // destructures a fixed option list, so the flag has to be threaded through both the
    // call site and the constructor or it is silently dropped.
    // The reply's API usage rides along the same way, as ccUsage: replayed history keeps it,
    // so turns with no recorded total can still count the main agent's tokens.
    name: "turn-queued",
    // ...,foldedIntoTurn:K=!1,isSynthesizedByLoop:D=!1,model:M,agentSender:P,statusAwayFromPrompt:j=!1}){this.type=$,...
    // (2.1.285 added options after isSynthesizedByLoop, so any trailing ones are kept as they are.)
    anchor: /foldedIntoTurn:([\w$]+)=!1,isSynthesizedByLoop:([\w$]+)=!1((?:,[\w$]+:[\w$]+(?:=![01])?)*)\}\)\{this\.type=([\w$]+),/g,
    replace: (_m, folded, loop, rest, type) =>
      `foldedIntoTurn:${folded}=!1,isSynthesizedByLoop:${loop}=!1${rest},isQueuedCommand:__ccQ=!1,ccUsage:__ccU}){this.isQueuedCommand=__ccQ,this.ccUsage=__ccU,this.type=${type},`,
  },
  {
    // The call site that builds a row from a raw frame: pass the frame's flag and usage through.
    name: "turn-queued-src",
    // return new dZ($.type,z,{uuid:$.uuid,foldedIntoTurn:J,betaMessageId:...
    anchor: /return new ([\w$]+)\(([\w$]+)\.type,([\w$]+),\{uuid:\2\.uuid,foldedIntoTurn:([\w$]+),/g,
    replace: (_m, cls, frame, content, folded) =>
      `return new ${cls}(${frame}.type,${content},{uuid:${frame}.uuid,isQueuedCommand:${frame}.isQueuedCommand===!0,ccUsage:${frame}.type==="assistant"?${frame}.message.usage:void 0,foldedIntoTurn:${folded},`,
  },
  {
    // Show the helper every frame from the CLI before the panel handles it. The result frame
    // at the end of each turn carries the session's running token totals, subagents included.
    name: "turn-tokens",
    // processIncomingMessage($){if(this.loadFailed.peek())this.loadOvertaken();...
    anchor: /processIncomingMessage\(([\w$]+)\)\{/g,
    replace: (m, frame) => `${m}window.__ccFrame&&window.__ccFrame(this,${frame});`,
  },
  {
    // "Worked for 1m 51s · 12k out · 1.4M total" under every finished turn in the chat history.
    name: "turn-history",
    // function fx($,J,Z,X,Y=!1,Q,G,z,q,U){let V=U?.readOnly??!1;if(J.isEmpty)return null;
    anchor: /function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)=!1,([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\11\?\.readOnly\?\?!1;if\(\3\.isEmpty\)return null;/g,
    replace: (m, name) =>
      `function ${name}(...a){let r=${name}__cc(...a);return window.__ccTurnLabel?window.__ccTurnLabel(r,${name}__cc,a):r}` +
      m.replace(`function ${name}(`, () => `function ${name}__cc(`),
    prepend: TIMER_HELPER,
  },
  {
    // Workflow-tool agents in the Agent map. Outside the session class, the places that read
    // the map's agents are all for display: the map itself, the agents pill in the input footer,
    // the check that shows that pill, the count logged when the map opens, and (from 2.1.304)
    // the status line under a backgrounded Agent/SendMessage call in the chat. Each gets the
    // helper's copy with the workflow agents added. The session's own reads (this.agentMapAgents)
    // and any assignment are left alone, so the panel's state never holds them. Another read
    // appearing in an update fails the count, so it gets looked at before it is patched.
    name: "agent-map",
    // let Z=$.agentMapAgents.value,X=pg($.permissionRequests.value);return F(hH5,{count:mg(Z),...
    // ...,E1=$.agentMapAgents.value,R1=q!==void 0&&E1.size>0,...
    anchor: /(?<![\w$.])(?!this\b)([\w$]+)\.agentMapAgents\.value(?!\s*=[^=])/g,
    count: [4, 5],
    replace: (_m, session) => `(window.__ccAgents?window.__ccAgents(${session}):${session}.agentMapAgents.value)`,
    prepend: TIMER_HELPER,
  },
  {
    // The map's transcript view reads an agent's transcript once and then follows the live rows
    // the panel receives for Agent-tool subagents. A workflow agent's rows never reach the panel,
    // so its entry carries ccRev, which changes while it works: reread when it does...
    name: "agent-map-reread",
    // ...return $.getSubagentTranscript(J.taskId,v).then(...)...},[$,J.taskId,U]);let A=$.messages.value,
    anchor: /\},\[([\w$]+),([\w$]+)\.taskId,([\w$]+)\]\);let ([\w$]+)=\1\.messages\.value,/g,
    replace: (_m, session, agent, retry, msgs) =>
      `},[${session},${agent}.taskId,${retry},${agent}.ccRev]);let ${msgs}=${session}.messages.value,`,
  },
  {
    // ...and on a reread, ask only for what was added since the last row it has. The panel
    // already does that for its own retries; its first read stays a full one.
    name: "agent-map-reread-from",
    // v=U>0&&!D.current&&H1!==void 0&&typeof n?.uuid==="string"?{count:H1.length,uuid:n.uuid}:void 0,d=j.current.removed;return $.getSubagentTranscript(J.taskId,v)
    anchor: /([\w$]+)=([\w$]+)>0(&&![\w$]+\.current&&[\w$]+!==void 0&&typeof [\w$]+\?\.uuid==="string"\?\{count:[\w$]+\.length,uuid:[\w$]+\.uuid\}:void 0,[\w$]+=[\w$]+\.current\.removed;return [\w$]+\.getSubagentTranscript\(([\w$]+)\.taskId,\1\))/g,
    replace: (_m, from, retry, rest, agent) => `${from}=(${retry}>0||${agent}.ccRev!==void 0)${rest}`,
  },
  {
    // The agents pill in the input footer: count the session's other background tasks (a shell
    // running in the background) beside the agents in its label...
    name: "tasks-pill-label",
    // function Jf5({count:$,dot:J,onOpen:Z}){let X=oE1($),Y=Zf5(J);
    anchor: /(\{count:([\w$]+),dot:([\w$]+),onOpen:[\w$]+\}\)\{let [\w$]+=)([\w$]+)(\(\2\),[\w$]+=[\w$]+\(\3\);)/g,
    replace: (_m, head, _count, _dot, label, tail) => `${head}(window.__ccPillLabel||${label})${tail}`,
  },
  {
    // ...light its dot while one runs...
    name: "tasks-pill-dot",
    // return F(Jf5,{count:Ll(Z),dot:iu1(Z,X),onOpen:J})
    anchor: /(\{count:[\w$]+\(([\w$]+)\),dot:)([\w$]+\(\2,[\w$]+\))(,onOpen:[\w$]+\}\))/g,
    replace: (_m, head, _agents, dot, tail) => `${head}(window.__ccPillDot||((d)=>d))(${dot})${tail}`,
  },
  {
    // ...and show it when only such tasks are running. The label here feeds the footer's
    // width measurement, so it takes the same label.
    name: "tasks-pill-show",
    // ,L1=q!==void 0&&h1.size>0,i1=L1?oE1(Ll(h1)):void 0
    anchor: /,([\w$]+)=([\w$]+)!==void 0&&([\w$]+)\.size>0,([\w$]+)=\1\?([\w$]+)\(([\w$]+)\(\3\)\):void 0/g,
    replace: (_m, shown, q, agents, label, fmt, count) =>
      `,${shown}=${q}!==void 0&&(${agents}.size>0||window.__ccTasks&&window.__ccTasks()>0),${label}=${shown}?(window.__ccPillLabel||${fmt})(${count}(${agents})):void 0`,
  },
];

// Every place the extension can be installed: WSL/remote server, a native
// install for this OS user, and (when run from WSL) the Windows-side installs.
function extensionRoots() {
  const roots = [
    path.join(os.homedir(), ".vscode-server", "extensions"),
    path.join(os.homedir(), ".vscode", "extensions"),
  ];
  if (fs.existsSync("/mnt/c/Users")) {
    for (const user of fs.readdirSync("/mnt/c/Users")) {
      roots.push(path.join("/mnt/c/Users", user, ".vscode", "extensions"));
    }
  }
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

// Newest installed version in each root; older version folders are leftovers.
function bundles() {
  const found = [];
  for (const root of extensionRoots()) {
    const dirs = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .map((d) => path.join(root, d))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dirs.length) found.push(path.join(dirs[0], "webview", "index.js"));
  }
  if (!found.length) throw new Error("no anthropic.claude-code-* extension found");
  return found;
}

function revert(bundle) {
  const backup = bundle + ".orig";
  if (!fs.existsSync(backup)) return console.log(`not patched  ${bundle}`);
  fs.copyFileSync(backup, bundle);
  fs.unlinkSync(backup);
  console.log(`reverted     ${bundle}`);
}

// Parse the patched source before it goes anywhere near the real bundle. A syntax error here
// would break the panel on next reload, and the panel is often the only way the user talks to
// Claude, so a bad patch must never reach disk. node --check needs a file, and it only treats
// the source as a module when the extension says so, hence the temporary .mjs.
function checkSyntax(source) {
  const tmp = path.join(os.tmpdir(), `cc-patch-check-${process.pid}-${Date.now()}.mjs`);
  try {
    fs.writeFileSync(tmp, source);
    child_process.execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    return null;
  } catch (e) {
    const err = e && e.stderr ? e.stderr.toString() : String(e && e.message);
    return err
      .split("\n")
      .filter((l) => l.trim() && !/^\s*\^/.test(l) && !l.includes(tmp))
      .map((l) => (l.length > 160 ? l.slice(0, 160) + " …" : l))
      .slice(0, 3)
      .join("\n             ");
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function patch(bundle) {
  const backup = bundle + ".orig";
  if (!fs.existsSync(backup)) {
    if (fs.readFileSync(bundle, "utf8").includes(MARKER)) {
      process.exitCode = 1;
      return console.error(`SKIPPED      ${bundle}\n             patched but index.js.orig is missing; reinstall the extension to get a clean copy`);
    }
    fs.copyFileSync(bundle, backup);
  }

  let out = fs.readFileSync(backup, "utf8");
  let prepend = MARKER;
  const applied = [];
  for (const p of PATCHES) {
    const found = [...out.matchAll(p.anchor)].length;
    const want = [].concat(p.count || 1);
    if (!want.includes(found)) {
      process.exitCode = 1;
      const n = want.join(" or ");
      console.error(`SKIPPED      ${p.name}: expected exactly ${n} anchor${want.some((w) => w > 1) ? "s" : ""}, found ${found}; the bundle changed, this patch needs updating`);
      continue;
    }
    out = out.replace(p.anchor, p.replace);
    if (p.prepend && !prepend.includes(p.prepend)) prepend += p.prepend;
    applied.push(p.name);
  }

  const patched = prepend + out;
  const error = checkSyntax(patched);
  if (error) {
    process.exitCode = 1;
    return console.error(
      `SKIPPED      ${bundle}\n             patched bundle does not parse, leaving it untouched:\n             ${error}`
    );
  }

  fs.writeFileSync(bundle, patched);
  console.log(`patched      ${bundle}  [${applied.join(", ") || "nothing applied"}]`);
}

const action = process.argv.includes("--revert") ? revert : patch;
bundles().forEach(action);
if (!process.exitCode) {
  console.log("Reload each VS Code window (Developer: Reload Window) to pick up the change.");
} else {
  console.error("Nothing was changed. Fix the errors above and run again.");
}
