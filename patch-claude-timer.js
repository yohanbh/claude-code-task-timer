#!/usr/bin/env node
// Local patches for the Claude Code VS Code panel (webview/index.js). Extension
// updates install into a new directory and drop them, so re-run this after each
// update. Every run rebuilds from the pristine index.js.orig, so after editing
// PATCHES below just run it again.
//
//   node patch-claude-timer.js            apply to every install found (WSL server + Windows)
//   node patch-claude-timer.js --revert   restore the original bundle
//
// Patches so far:
//   turn-timer    live "Working for 1m 2s" next to the spinner
//   turn-jsx      expose the JSX factory to the helper
//   turn-queued   keep the host's isQueuedCommand flag on the row (survives reloads)
//   turn-stamp    hover tooltip with the time a message was sent (part of turn-history)
//   turn-history  "Worked for 1m 51s" under every finished turn in the chat history

const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process = require("child_process");

const MARKER = "/*cc-local-patches*/";

const TIMER_HELPER = `;(()=>{try{
// session -> {start, len, measured: Map(promptUuid -> ms)}; filled from the busy signal
const sessions=new WeakMap();
// messages array -> {busy, map}; turn labels are derived per render, never stored in the panel's data
const cache=new WeakMap();
let current=null,el=null;
const fmt=(ms)=>{const s=Math.round(ms/1000),m=Math.floor(s/60);return m?m+"m "+(s%60)+"s":s+"s"};
const top=(m)=>!m.parentToolUseId&&!m.sdkParentToolUseId;
const at=(m)=>m.createdAt==null?m.timestamp:m.createdAt;
// A prompt that starts a turn: a human message, or an automatic one (finished
// background subagent/task, peer session). Tool results, hidden and folded messages are not.
const isBoundary=(m)=>{
  if(m.type!=="user"||!top(m)||m.isEmpty||m.foldedIntoTurn||m.isSynthetic===true)return false;
  if(m.origin!=null)return true;
  if(m.content.some((c)=>c.content.type!=="text"))return true;
  const c=m.content[0]&&m.content[0].content,t=String((c&&c.text)||"").trimStart();
  return !(t.startsWith("<")||t.startsWith("["));
};
// A prompt typed while I'm already working is held in heldPrompts and absorbed into the
// running turn, so it must not close it. Two sources say so, because neither covers both cases:
//   isQueuedCommand - set by the extension host when it rebuilds the row from the transcript's
//     queued_command attachment, so it survives a reload (the turn-queued patch copies it onto
//     the row; the stock webview drops it).
//   the live set    - for the turn happening right now, where the row was appended by
//     appendPickedUp and carries no flag at all.
const isAbsorbed=(m,st)=>m.isQueuedCommand===true||!!(st&&st.absorbed.has(m.uuid));
const labels=(s)=>{
  const msgs=s.messages.value,busy=s.busy.value,hit=cache.get(msgs);
  if(hit&&hit.busy===busy)return hit.map;
  const map=new Map(),st=sessions.get(s);let start=null,last=null;
  const close=(isLast)=>{
    if(!start||!last||(isLast&&busy))return;
    let ms=st&&st.measured.get(start.uuid);
    if(ms==null)ms=at(last)-at(start);
    if(ms>=1000&&isFinite(ms))map.set(last.uuid||last,ms);
  };
  // Subagent messages carry a parent tool id, so they never start, end or stretch a turn;
  // their own rows keep the native timer.
  // A prompt typed while I'm already working is held in heldPrompts and absorbed into the
  // running turn. appendPickedUp pushes it into messages without the foldedIntoTurn flag that
  // the replay path sets, and the finished row carries no marker, so it is indistinguishable
  // from a fresh prompt by shape alone. We instead record it live (see the busy subscription):
  // any boundary prompt that shows up while a turn is already running is absorbed, not a start.
  for(const m of msgs){
    if(isBoundary(m)&&!isAbsorbed(m,st)){close(false);start=m;last=null}
    else if(m.type==="assistant"&&top(m)&&!m.isEmpty)last=m;
  }
  close(true);cache.set(msgs,{busy,map});return map;
};
const paint=()=>{try{
  const st=current&&sessions.get(current),host=document.querySelector("[data-cc-timer]");
  if(!host||!st||!st.start){if(el){el.remove();el=null}return}
  if(!el||el.parentNode!==host){
    if(el)el.remove();
    el=document.createElement("span");
    el.style.marginLeft="8px";el.style.fontSize="0.9em";
    el.style.color="var(--vscode-descriptionForeground)";
    host.appendChild(el);
  }
  el.textContent="Working for "+fmt(Date.now()-st.start);
}catch(e){}};
setInterval(paint,1000);
// Called from the main chat view's render with its session.
window.__ccTurnTimer=(s)=>{try{
  current=s;
  if(!sessions.has(s)){
    const st={start:0,len:0,measured:new Map(),absorbed:new Set(),seen:new Set(),everBusy:false};sessions.set(s,st);
    // Prompts already present when the turn began; anything boundary-shaped that appears
    // after this while busy was typed mid-turn and folded into the running turn.
    const noteAbsorbed=()=>{try{
      if(!st.start)return;
      for(const m of s.messages.value){
        if(!isBoundary(m)||!m.uuid||st.seen.has(m.uuid)||m.isQueuedCommand===true)continue;
        st.absorbed.add(m.uuid);cache.delete(s.messages.value);
      }
    }catch(e){}};
    const markSeen=()=>{try{for(const m of s.messages.value)if(m.uuid)st.seen.add(m.uuid)}catch(e){}};
    s.messages.subscribe(()=>{noteAbsorbed()});
    s.busy.subscribe((b)=>{try{
      if(b&&!st.start){
        markSeen();st.len=s.messages.value.length;
        // A reload rebuilds the webview mid-turn, so there is no record of when the running
        // turn began and the clock would restart from zero. The prompt that started it is in
        // the restored history with a transcript timestamp, so recover the real start from it.
        // Only trust it when it is in the past and recent enough to be this turn; otherwise
        // (a fresh send, where the row may not be in messages yet) fall back to now.
        const now=Date.now();let from=null;
        try{
          // Walk back to the prompt that opened the current turn. Replies and tool traffic
          // sit between it and here, so they are skipped rather than ending the search.
          const msgs=s.messages.value;
          for(let i=msgs.length-1;i>=0;i--){
            const m=msgs[i];
            if(isBoundary(m)&&!isAbsorbed(m,st)){const t=at(m);if(t!=null&&isFinite(t))from=t;break}
          }
        }catch(e){}
        // The send path appends the prompt row before flipping busy, so a fresh send finds its
        // own prompt and the difference is ~0. A reattach after a reload finds the prompt of the
        // turn already in flight and recovers the minutes it has been running. The recovered
        // value is only used when this session has not seen a turn of its own yet, which is what
        // a rebuilt webview looks like; that keeps a stale prompt from an earlier finished turn
        // out of a later one. Clock skew and absurd gaps fall back to now.
        const firstTurn=st.measured.size===0&&!st.everBusy;
        st.start=(from!=null&&from<=now&&now-from<86400000&&(firstTurn||now-from<5000))?from:now;
        st.everBusy=true;
      }
      else if(!b&&st.start){
        const ms=Date.now()-st.start,msgs=s.messages.value;st.start=0;
        const mine=msgs.slice(Math.max(0,st.len-1)).filter((m)=>isBoundary(m)&&!isAbsorbed(m,st));
        if(mine.length===1&&mine[0].uuid)st.measured.set(mine[0].uuid,ms);
        markSeen();
        cache.delete(msgs);
      }
      setTimeout(paint,0);
    }catch(e){}});
  }
  setTimeout(paint,0);
}catch(e){}};
// Hover tooltip: absolute time a message was sent. createdAt comes from the transcript
// timestamp, so it is correct for live messages and survives a reload. The date is included
// only when the message is not from today, to keep the common case short.
const stamp=(ms)=>{try{
  const d=new Date(ms),now=new Date();
  const time=d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit",second:"2-digit"});
  const sameDay=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();
  if(sameDay)return time;
  return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:d.getFullYear()===now.getFullYear()?undefined:"numeric"})+", "+time;
}catch(e){return null}};
// React props are frozen, so the row cannot be edited in place; wrap it in a titled span
// that lays out like the row it replaces (display:contents keeps the panel's own CSS intact).
const withStamp=(row,m)=>{try{
  if(row==null||!window.__ccJsx)return row;
  const t=m&&m.createdAt;
  if(t==null||!isFinite(t))return row;
  const label=stamp(t);
  if(!label)return row;
  return window.__ccJsx("div",{title:label,style:{display:"contents"},children:row});
}catch(e){return row}};
// Wraps the per-message renderer: after the last reply of a finished turn, add a
// native-styled meta row. Rows rendered with options (held prompts, the read-only
// transcript/subagent viewer) are left alone.
window.__ccTurnLabel=(r,orig,args)=>{try{
  const s=args[0],m=args[1];
  // The hover stamp applies to every rendered row, including held prompts and the
  // read-only viewer; the turn label below is narrower.
  r=withStamp(r,m);
  if(args[9]||!s||!s.messages||!s.busy||!m||m.type!=="assistant")return r;
  const ms=labels(s).get(m.uuid||m);
  if(ms==null)return r;
  const a=args.slice();
  a[1]={isEmpty:false,type:"meta",content:[{content:{type:"text",text:"Worked for "+fmt(ms)}}]};
  a[2]="cc-timer-"+(m.uuid||args[2]);
  const label=orig.apply(null,a);
  return r==null?label:[r,label];
}catch(e){return r}};
}catch(e){}})();
`;

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
