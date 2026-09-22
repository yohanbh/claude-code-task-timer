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

// One entry per change. `anchor` must match exactly once in the bundle; names
// there are minified and change every release, so match by shape and capture
// them. `prepend` (optional) is code added once to the top of the bundle; wrap
// it in try/catch so a bug in a patch can never stop the panel from loading.
const PATCHES = [
  {
    // Live "Working for 1m 2s" in the main chat's spinner row.
    name: "turn-timer",
    // let q7=$.busy.value&&!$.permissionRequests.value.length,U7=F("div",{className:x0.spinnerRow,
    anchor: /let ([\w$]+)=([\w$]+)\.busy\.value&&!\2\.permissionRequests\.value\.length,([\w$]+)=([\w$]+)\("div",\{className:([\w$]+)\.spinnerRow,/g,
    replace: (_m, flag, session, row, jsx, styles) =>
      `let ${flag}=(window.__ccTurnTimer&&window.__ccTurnTimer(${session}),${session}.busy.value)&&!${session}.permissionRequests.value.length,${row}=${jsx}("div",{"data-cc-timer":"1",className:${styles}.spinnerRow,`,
    prepend: TIMER_HELPER,
  },
  {
    // Hand the helper the JSX factory, so it can wrap a row in a tooltip element.
    // var B1=mL0,F=Mk1,R=Mk1;
    name: "turn-jsx",
    anchor: /var ([\w$]+)=([\w$]+),([\w$]+)=([\w$]+),([\w$]+)=\4;/g,
    replace: (m, b1, mL0, F, Mk1, R) =>
      `${m}window.__ccJsx=${F};`,
  },
  {
    // Carry the host's isQueuedCommand flag onto the rendered row. The host sets it when it
    // rebuilds a prompt that was typed mid-turn from the transcript's queued_command
    // attachment, so it is the one marker that survives a reload. The row constructor
    // destructures a fixed option list, so the flag has to be threaded through both the
    // call site and the constructor or it is silently dropped.
    name: "turn-queued",
    // ...,foldedIntoTurn:B=!1,isSynthesizedByLoop:K=!1}){this.type=$,this.uuid=Z,...
    anchor: /foldedIntoTurn:([\w$]+)=!1,isSynthesizedByLoop:([\w$]+)=!1\}\)\{this\.type=([\w$]+),/g,
    replace: (_m, folded, loop, type) =>
      `foldedIntoTurn:${folded}=!1,isSynthesizedByLoop:${loop}=!1,isQueuedCommand:__ccQ=!1}){this.isQueuedCommand=__ccQ,this.type=${type},`,
  },
  {
    // The call site that builds a row from a raw frame: pass the frame's flag through.
    name: "turn-queued-src",
    // return new dZ($.type,z,{uuid:$.uuid,foldedIntoTurn:J,betaMessageId:...
    anchor: /return new ([\w$]+)\(([\w$]+)\.type,([\w$]+),\{uuid:\2\.uuid,foldedIntoTurn:([\w$]+),/g,
    replace: (_m, cls, frame, content, folded) =>
      `return new ${cls}(${frame}.type,${content},{uuid:${frame}.uuid,isQueuedCommand:${frame}.isQueuedCommand===!0,foldedIntoTurn:${folded},`,
  },
  {
    // "Worked for 1m 51s" under every finished turn in the chat history.
    name: "turn-history",
    // function fx($,J,Z,X,Y=!1,Q,G,z,q,U){let V=U?.readOnly??!1;if(J.isEmpty)return null;
    anchor: /function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)=!1,([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\11\?\.readOnly\?\?!1;if\(\3\.isEmpty\)return null;/g,
    replace: (m, name) =>
      `function ${name}(...a){let r=${name}__cc(...a);return window.__ccTurnLabel?window.__ccTurnLabel(r,${name}__cc,a):r}` +
      m.replace(`function ${name}(`, () => `function ${name}__cc(`),
    prepend: TIMER_HELPER,
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
    if (found !== 1) {
      process.exitCode = 1;
      console.error(`SKIPPED      ${p.name}: expected exactly 1 anchor, found ${found}; the bundle changed, this patch needs updating`);
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
