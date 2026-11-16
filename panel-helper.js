// Injected verbatim into the Claude Code panel bundle by patch-claude-timer.js.
// This file is never run by node: it is prepended to webview/index.js and runs in the
// panel's webview, so it must be self-contained and must not use require/module.
// Everything here is display-only. It reads the panel's state and wraps its render
// function; it never writes to session.messages, which carries index bookkeeping
// (replayInsertIndex, eviction, teleportedMessageCount) that is not safe to touch.
//
// The whole thing is wrapped in try/catch so a bug in here can never stop the panel
// from loading.

;(()=>{try{
// session -> {start, len, measured: Map(promptUuid -> ms)}; filled from the busy signal
const sessions=new WeakMap();
// messages array -> {busy, map}; turn labels are derived per render, never stored in the panel's data
const cache=new WeakMap();
let current=null,el=null;
const fmt=(ms)=>{const t=Math.round(ms/1000),h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=t%60;return h?h+"h "+m+"m "+s+"s":m?m+"m "+s+"s":s+"s"};
// 950 -> "950", 12345 -> "12k", 1234567 -> "1.2M"
const num=(n)=>{if(n<1000)return String(n);const [d,u]=n<999500?[1e3,"k"]:[1e6,"M"],v=n/d;return (v<10?v.toFixed(1).replace(/\.0$/,""):String(Math.round(v)))+u};
const top=(m)=>!m.parentToolUseId&&!m.sdkParentToolUseId;
const at=(m)=>m.createdAt==null?m.timestamp:m.createdAt;
// A background subagent reporting back belongs to the turn that launched it, and the clock
// runs while it works. Any other finished background task (a Bash render, a Monitor event)
// resumes the turn before it instead: the agent's time before and after counts, the wait in
// between does not, so a dev server exiting hours later adds only the reply it gets.
// Live, the CLI never sends the panel the notification's user message: the turn it starts
// simply has no prompt row (the row only appears in the history a reload rebuilds from the
// transcript). So a resume is recognised by that absence, in the busy subscription below, and
// the notification rows are only used to split a reloaded turn into its stretches.
const text=(m)=>m.content.map((c)=>(c.content&&c.content.text)||"").join("");
const isAgentReport=(m)=>m.origin.kind==="task-notification"&&/<summary>Agent "/.test(text(m));
const shown=(m)=>m.type==="user"&&top(m)&&!m.isEmpty&&!m.foldedIntoTurn&&m.isSynthetic!==true;
const isResume=(m)=>shown(m)&&m.origin!=null&&m.origin.kind==="task-notification"&&!isAgentReport(m);
// A prompt that starts a turn: a human message, or another session's. Tool results, hidden
// and folded messages, and background task notifications are not.
const isBoundary=(m)=>{
  if(!shown(m))return false;
  if(m.origin!=null)return m.origin.kind!=="task-notification";
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
// The prompt that opened the running turn, from the messages that arrived since it began.
const opener=(s,st)=>{const mine=s.messages.value.slice(Math.max(0,st.len-1)).filter((m)=>isBoundary(m)&&!isAbsorbed(m,st));return mine.length===1?mine[0]:null};
// Tokens, as [output, everything]; everything = input + cache writes + cache reads + output.
// Each result frame from the CLI carries the session's running totals (main agent, foreground
// and background subagents, compaction), so a turn's usage is how much they grew across it.
// Subagent rows are no use for this: their usage is a snapshot from the start of each reply.
// Totals are kept in localStorage by the prompt that opened the turn, so the label survives a
// reload, and the session's last running total is kept too, so the first turn after a reload
// still has a starting point. Turns without a record fall back to the main agent's replies.
const TK="cc-tokens:turn:",SK="cc-tokens:session:";
const fromModels=(mu)=>{let o=0,a=0;for(const u of Object.values(mu)){const out=u.outputTokens||0;o+=out;a+=out+(u.inputTokens||0)+(u.cacheReadInputTokens||0)+(u.cacheCreationInputTokens||0)}return [o,a]};
const fromRow=(u)=>{const out=u.output_tokens||0;return [out,out+(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0)]};
const stored=new Map();
const load=(k)=>{if(!stored.has(k)){let v=null;try{v=JSON.parse(localStorage.getItem(k))}catch(e){}stored.set(k,v)}return stored.get(k)};
const save=(k,v)=>{v.at=Date.now();stored.set(k,v);try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
// Keep the newest records under a prefix so the panel's storage does not grow without bound.
const prune=(prefix,max)=>{try{
  const ks=[];
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith(prefix))ks.push([k,(load(k)||{}).at||0])}
  ks.sort((x,y)=>x[1]-y[1]).slice(0,Math.max(0,ks.length-max)).forEach(([k])=>{localStorage.removeItem(k);stored.delete(k)});
}catch(e){}};
prune("cc-tokens:",5000);
const sid=(s)=>{try{return s.sessionId.peek()||null}catch(e){return null}};
// The agents pill in the input footer counts Agent-tool subagents only, and hides without
// any; a background shell running on its own shows as "0 agents" or nothing. Count the
// session's other background tasks beside it and light the dot while one runs. Workflow runs
// are left out here, since they are already in the map as agents. The map itself lists these
// tasks natively, so the click needs nothing.
const tasksOf=(s)=>{try{let n=0;for(const t of s.backgroundTasks.value.values())if(t.taskType!=="local_workflow")n++;return n}catch(e){return 0}};
window.__ccTasks=(s)=>tasksOf(s||current);
window.__ccPillLabel=(n)=>{
  const k=current?tasksOf(current):0,a=n+(n===1?" agent":" agents"),t=k+(k===1?" task":" tasks");
  return k?(n?a+" · "+t:t):a;
};
// The context ring's paths, drawn to the real percentage. Natively the ring has three fixed
// shapes (50/75/99% used), so anything under 62.5% drew as a half ring. Same geometry as the
// native ones: a circle of radius 5 at (10,10), the orange arc runs clockwise from the top,
// and a faint track follows it after a 30° gap and stops 30° short of the top.
window.__ccRing=(p)=>{
  const pt=(a)=>{const r=a*Math.PI/180;return (10+5*Math.sin(r)).toFixed(3)+" "+(10-5*Math.cos(r)).toFixed(3)};
  const arc=(a,b)=>"M"+pt(a)+"A5 5 0 "+(b-a>180?1:0)+" 1 "+pt(b);
  const end=Math.max(1,Math.min(330,(+p||0)*3.6));
  return {arc:arc(0,end),track:end+30<330?arc(end+30,330):null};
};
// The window the ring measures against. The panel takes the model's own from each result frame
// (1M for Fable), but an autoCompactWindow setting makes the CLI compact against a smaller one,
// so the ring read about half the real usage. The data behind /context has the window in force
// (rawMaxTokens): ask for it once per session and model window, then redraw the ring.
// The panel learns the window only from a finished turn's result frame, and transcripts hold
// none, so the ring also hid in a new conversation, a resumed one, and every open one after a
// window reload, until a reply finished. The last window seen is kept per session and overall,
// and stands in until the session reports its own. `limit` is the panel's own formula.
const wins=new WeakMap(),RK="cc-ring:session:",RL="cc-ring:last";
prune(RK,500);
const keepRing=(s,c)=>{const v={w:c.w,o:c.o,max:c.max},id=sid(s);if(id)save(RK+id,v);save(RL,{...v})};
window.__ccLimit=(s,limit)=>{const u=s.usageData.value;try{
  const w=u.contextWindow,o=u.maxOutputTokens,id=sid(s);
  if(!(w>0)){const r=(id&&load(RK+id))||load(RL);return r?limit(r.max||r.w,r.o):limit(w,o)}
  let c=wins.get(s);
  if(!c||c.w!==w||c.o!==o){
    const r=(id&&load(RK+id))||load(RL);
    c={w,o,max:r&&r.w===w?r.max:0};wins.set(s,c);keepRing(s,c);
    s.getContextUsage().then((x)=>{
      const m=x&&x.usage&&x.usage.rawMaxTokens;
      if(!(m>0))return;
      const max=m===w?0:m;
      if(max!==c.max){c.max=max;s.usageData.value={...s.usageData.value}}
      keepRing(s,c);
    }).catch(()=>{});
  }
  return limit(c.max||w,o);
}catch(e){return limit(u.contextWindow,u.maxOutputTokens)}};
window.__ccPillDot=(d)=>d==="waiting"||d==="failed"||!current||!tasksOf(current)?d:"running";
// Workflow-tool agents in the panel's own Agent map (the agents pill in the input footer).
// The panel tracks only Agent-tool subagents there; a Workflow-tool run is one background task
// with nothing per agent. The CLI does report a run's agents: while it runs, its task_progress
// frames carry workflow_progress, every agent with its agentId, label, phase, state, tokens and
// tool calls (the whole list at least every 10s, and at once when an agent starts or ends). The
// panel ignores that field. We keep it, and show each run in the map as an agent with its agents
// under it. Opening one loads its transcript through the panel's own request, whose search of the
// session's subagents folder reaches workflow agents too. Nothing is written to the panel's state:
// the map reads its agents through __ccAgents (the agent-map patch), which adds these to a copy.
// Runs are kept in localStorage per session, so a reload does not lose them.
const WK="cc-wf:";
prune(WK,20);
const ENDED={completed:"finished",failed:"failed",killed:"stopped",stopped:"stopped"};
// session -> {runs: Map(taskId -> run), sig: a panel signal bumped on change, key, merged, timer}
const flows=new WeakMap();
const flow=(s)=>{
  let f=flows.get(s);
  if(!f){
    // A signal of the panel's own kind, so the components reading the map redraw when it changes.
    let sig=null;try{sig=new s.agentMapAgents.constructor(0)}catch(e){}
    f={runs:new Map(),sig,key:null,merged:null,timer:0};flows.set(s,f);
  }
  const id=sid(s);
  if(id&&f.key!==WK+id){
    f.key=WK+id;const r=load(f.key);
    if(r&&Array.isArray(r.runs))for(const run of r.runs)if(run&&run.taskId&&!f.runs.has(run.taskId))f.runs.set(run.taskId,run);
  }
  return f;
};
// Redraw, and store the session's newest runs, at most twice a second.
const changed=(f)=>{if(f.timer)return;f.timer=setTimeout(()=>{try{
  f.timer=0;f.merged=null;
  if(f.sig)f.sig.value=f.sig.peek()+1;
  if(f.key)save(f.key,{runs:[...f.runs.values()].sort((a,b)=>b.startTime-a.startTime).slice(0,5)});
}catch(e){}},500)};
const workflowFrame=(s,fr)=>{try{
  const st=fr.subtype;
  if(st!=="task_progress"&&st!=="task_notification"&&st!=="task_updated")return;
  const f=flow(s);let run=f.runs.get(fr.task_id);
  if(st==="task_progress"){
    const list=fr.workflow_progress,u=fr.usage||{};
    // Progress for Agent-tool subagents and shells has no list, and is not ours.
    if(!run){
      if(!Array.isArray(list))return;
      const bg=s.backgroundTasks&&s.backgroundTasks.peek().get(fr.task_id);
      run={taskId:fr.task_id,toolUseId:fr.tool_use_id,name:fr.summary||(bg&&bg.description)||"workflow",startTime:(bg&&bg.startTime)||Date.now()-(u.duration_ms||0),agents:[]};
      f.runs.set(run.taskId,run);
    }
    if(Array.isArray(list))run.agents=list.filter((a)=>a&&a.type==="workflow_agent");
    if(fr.usage){run.tokens=u.total_tokens;run.toolUses=u.tool_uses}
    run.status="working";run.endTime=void 0;run.at=Date.now();
    // An agent's transcript open in the map reads on from where it was when this changes.
    run.tick=Math.floor(run.at/2000);
  }else{
    const status=ENDED[st==="task_notification"?fr.status:fr.patch&&fr.patch.status];
    if(!run||!status)return;
    run.status=status;run.endTime=(fr.patch&&fr.patch.end_time)||Date.now();
    if(fr.summary)run.result=fr.summary;
  }
  changed(f);
}catch(e){}};
// A run seen working is still working while the panel lists it as a running background task.
// Before that list catches up, a recent frame counts; past that, the run ended while the panel
// was not watching (closed or reloading).
const runStatus=(run,ids)=>{
  if(run.status!=="working")return run.status;
  if(ids&&ids.has(run.taskId)||Date.now()-(run.at||0)<60000)return "working";
  return run.agents.every((a)=>a.state==="done")?"finished":"stopped";
};
// Entries shaped like the panel's own agent records: the run under the session, its agents
// under the run (linked by the Workflow call's tool use id, as the map links subagents).
const workflowAgents=(f,ids)=>{
  const out=[],now=Date.now();
  for(const run of f.runs.values()){
    const status=runStatus(run,ids),live=status==="working",end=live?now:run.endTime||run.at||now;
    out.push({taskId:run.taskId,toolUseId:run.toolUseId,description:"Workflow: "+run.name,subagentType:"workflow",status,isBackgrounded:true,
      startTime:run.startTime,endTime:live?void 0:end,usage:{totalTokens:run.tokens||0,toolUses:run.toolUses||0,durationMs:end-run.startTime},summary:run.result});
    for(const a of run.agents){
      // An agent still going when its run ended was cut short.
      const st=a.state==="done"?"finished":a.state==="error"?"failed":live?"working":"stopped",start=a.startedAt||a.queuedAt||run.startTime;
      out.push({taskId:a.agentId||run.taskId+"-"+a.index,parentToolUseId:run.toolUseId,description:(a.phaseTitle?a.phaseTitle+": ":"")+(a.label||"agent "+a.index),
        subagentType:a.agentType||"workflow agent",model:a.model,status:st,isBackgrounded:true,startTime:start,endTime:st==="working"||!a.durationMs?void 0:start+a.durationMs,
        usage:{totalTokens:a.tokens||0,toolUses:a.toolCalls||0,durationMs:a.durationMs||0},prompt:a.promptPreview,summary:a.resultPreview||a.error,ccRev:st==="working"?run.tick:-1});
    }
  }
  return out;
};
// Called where the map, its footer pill and the pill's visibility check read the session's
// agents: the panel's own agents, plus the workflow ones. The same Map comes back until
// something changes, so the map's memoised tree is not rebuilt on every render.
window.__ccAgents=(s)=>{
  const base=s.agentMapAgents.value;
  try{
    const f=flow(s),ver=f.sig?f.sig.value:-1,ids=s.backgroundTaskIds?s.backgroundTaskIds.value:null;
    if(!f.runs.size)return base;
    const m=f.merged;
    if(m&&ver!==-1&&m.base===base&&m.ver===ver&&m.ids===ids)return m.map;
    const map=new Map(base);
    for(const e of workflowAgents(f,ids))if(!map.has(e.taskId))map.set(e.taskId,e);
    f.merged={base,ver,ids,map};
    return map;
  }catch(e){return base}
};
// Background tasks (shells, Monitor watches) in the Agent map, each under the agent that started
// it. Natively the map lists them flat under the tree, says nothing about who started them, and
// drops each the moment it ends. The CLI does say: task_started and background_tasks_changed carry
// parent_task_id, the task id of the subagent that launched the task (the key the map has for that
// agent; absent for the main agent and for workflow agents), and task_started carries the id of
// the launching tool call. The panel keeps neither. We do, and the task-tree patch adds each task
// to the tree as a node under its agent, ended ones included until the panel reloads. A workflow
// agent's task is matched by finding its tool call in the transcripts of the workflow agents that
// were running when it started; until a task's agent is known it stays in the native flat list.
// Clicking one opens the panel's own task card (which already shows the live output), with
// "Started by" and the command added. Looked up only while the map or a card is open.
{
const books=new WeakMap(); // session -> {recs: Map(taskId -> record), sig, tick}
const byId=new Map(); // taskId -> record, for the click and the card, which only have the id
const book=(s)=>{
  let b=books.get(s);
  if(!b){let sig=null;try{sig=new s.agentMapAgents.constructor(0)}catch(e){}b={recs:new Map(),sig,tick:0};books.set(s,b)}
  return b;
};
const bump=(b)=>{if(b.tick)return;b.tick=setTimeout(()=>{b.tick=0;try{if(b.sig)b.sig.value=b.sig.peek()+1}catch(e){}},100)};
const own=(t)=>t&&t!=="local_agent"&&t!=="local_workflow";
const rec=(s,b,id)=>{
  let r=b.recs.get(id);
  if(r)return r;
  r={taskId:id,sid:sid(s),first:Date.now()};b.recs.set(id,r);byId.set(id,r);
  // Every Bash call registers a task, foreground ones too; only background ones are shown.
  if(b.recs.size>300)for(const [k,v] of b.recs){if(b.recs.size<=200)break;if(!v.bg||v.goneAt){b.recs.delete(k);byId.delete(k)}}
  if(byId.size>1000)byId.delete(byId.keys().next().value);
  return r;
};
window.__ccTaskFrame=(s,f)=>{try{
  const st=f.subtype;
  if(st==="background_tasks_changed"&&Array.isArray(f.tasks)){
    const b=book(s),now=Date.now(),live=new Set();
    for(const t of f.tasks){
      if(!t||!t.task_id||!own(t.task_type))continue;
      const r=rec(s,b,t.task_id);live.add(r.taskId);
      // Seen here before task_started (or only here, after a reload): the start is a guess.
      if(!r.startTime){r.startTime=now;r.guessStart=true}
      r.bg=true;r.goneAt=0;r.taskType=t.task_type;
      if(t.description)r.description=t.description;
      if(t.parent_task_id)r.parent=t.parent_task_id;
    }
    for(const r of b.recs.values())if(r.bg&&!r.goneAt&&!live.has(r.taskId))r.goneAt=now;
    bump(b);
  }else if(st==="task_started"&&f.task_id&&own(f.task_type)){
    const b=book(s),r=rec(s,b,f.task_id);
    r.taskType=f.task_type;
    if(f.description)r.description=f.description;
    if(f.tool_use_id)r.toolUseId=f.tool_use_id;
    if(f.parent_task_id)r.parent=f.parent_task_id;
    // The CLI marks a shell started by any agent (subagent or workflow agent); a shell without
    // the mark is the main agent's. Other kinds are never marked, so for them it says nothing.
    r.owned=f.owned_by_subagent===true?true:f.task_type==="local_bash"?false:void 0;
    if(!r.startTime||r.guessStart){r.startTime=Date.now();r.guessStart=false}
    bump(b);
  }else if((st==="task_notification"||st==="task_updated")&&f.task_id){
    const b=books.get(s),r=b&&b.recs.get(f.task_id),status=ENDED[st==="task_notification"?f.status:f.patch&&f.patch.status];
    if(!r||!status)return;
    // The panel's own clock, as for the start: the CLI's end_time can come from WSL's clock.
    r.status=status;r.endTime=r.endTime||Date.now();
    bump(b);
  }
}catch(e){}};
// The tool call that started a task: by its id, or (after a reload, when the id is gone) by the
// tool result that names the task. Only calls with a command are looked at (Bash, PowerShell,
// Monitor). Rows are the panel's, newest first; frames are transcript lines.
const mentions=(v,id)=>{try{const t=typeof v==="string"?v:JSON.stringify(v==null?"":v);return t.length<500000&&t.includes(id)}catch(e){return false}};
const isCall=(b)=>b&&b.type==="tool_use"&&b.input&&typeof b.input.command==="string";
const callIn=(msgs,r)=>{
  for(let i=msgs.length-1;i>=0;i--){
    const m=msgs[i];if(!m||!Array.isArray(m.content))continue;
    for(const c of m.content){
      const b=c&&c.content;if(!isCall(b))continue;
      if(r.toolUseId?b.id===r.toolUseId:mentions(c.toolResult&&(c.toolResult.peek?c.toolResult.peek():c.toolResult.value),r.taskId))return {row:m,call:b};
    }
  }
  return null;
};
const blocks=(f)=>{const c=f&&f.message&&f.message.content;return Array.isArray(c)?c:[]};
const callInFrames=(frames,r)=>{
  let id=r.toolUseId;
  if(!id)for(const f of frames){for(const b of blocks(f))if(b&&b.type==="tool_result"&&mentions(b.content,r.taskId)){id=b.tool_use_id;break}if(id)break}
  if(id)for(const f of frames)for(const b of blocks(f))if(isCall(b)&&b.id===id)return {time:f.timestamp,call:b};
  return null;
};
const take=(r,call,t)=>{
  r.cmd=call.input.command;r.tool=call.name;
  const v=typeof t==="number"?t:Date.parse(t);
  if(r.guessStart&&isFinite(v)&&v<r.startTime)r.startTime=v;
  r.guessStart=false;
};
// Workflow agents running when the task started: the only ones that can have started it.
const candidates=(s,r)=>{
  const f=flows.get(s),out=[];if(!f)return out;
  const t=r.startTime||r.first;
  for(const run of f.runs.values())for(const a of run.agents){
    if(!a.agentId)continue;
    const from=a.startedAt||a.queuedAt||run.startTime,to=a.state==="done"||a.state==="error"?from+(a.durationMs||0):Infinity;
    if(from-60000<=t&&t<=to+60000)out.push(a.agentId);
  }
  return out.slice(0,12);
};
const found=(r)=>!!(r.cmd&&(r.parent||r.owner));
const look=(s,b,r)=>{
  if(found(r))return;
  // The chat's own rows first: the main agent's calls, and a foreground subagent's.
  const msgs=s.messages.peek();
  if(!r.cmd&&r.scanned!==msgs&&(r.scans||0)<20){
    r.scanned=msgs;r.scans=(r.scans||0)+1;
    const hit=callIn(msgs,r);
    if(hit){take(r,hit.call,at(hit.row));if(!r.parent&&top(hit.row))r.owner="main"}
  }
  if(!r.parent&&!r.owner&&r.owned===false)r.owner="main";
  if(found(r)||r.asking||(r.tries||0)>=5||Date.now()-(r.askedAt||0)<5000)return;
  // Then transcripts: the subagent that started it, or the workflow agents that may have.
  const ids=r.parent?[r.parent]:r.owner?[]:candidates(s,r);
  if(!ids.length)return;
  r.asking=true;r.askedAt=Date.now();r.tries=(r.tries||0)+1;
  Promise.all(ids.map((id)=>Promise.resolve().then(()=>s.getSubagentTranscript(id)).then((x)=>({id,frames:(x&&x.frames)||[]}),()=>({id,frames:[]})))).then((all)=>{
    r.asking=false;
    for(const x of all){const hit=callInFrames(x.frames,r);if(hit){take(r,hit.call,hit.time);if(!r.parent)r.owner=x.id;break}}
    // A transcript can lag the call by a moment: look again shortly, a few times at most.
    if(!found(r)&&r.tries<5)setTimeout(()=>bump(b),5000);
    bump(b);
  }).catch(()=>{r.asking=false});
};
const statusOf=(s,r)=>{
  try{if(s.backgroundTasks.peek().has(r.taskId))return "working"}catch(e){}
  if(r.status)return r.status;
  return r.goneAt?"finished":"stopped";
};
const KIND={local_bash:"Shell",monitor_mcp:"Monitor",monitor_ws:"Monitor"};
// Shaped like the panel's agent records, so the map's own row draws it: title, status dot, time.
const entry=(s,r)=>{
  const status=statusOf(s,r),live=status==="working";
  const kind=r.tool==="Monitor"?"Monitor":KIND[r.taskType]||"Task";
  return {taskId:r.taskId,description:kind+": "+(r.description||r.cmd||"background task"),taskType:r.taskType,status,isBackgrounded:true,
    startTime:r.startTime||r.first,endTime:live?void 0:r.endTime||r.goneAt||Date.now(),usage:{totalTokens:0,toolUses:0},ccTask:true};
};
const order=(a,b)=>(a.status==="working")!==(b.status==="working")?(a.status==="working"?-1:1):(b.endTime||0)-(a.endTime||0)||b.startTime-a.startTime;
// The map's tree (its own build of the agents), with each agent's tasks on its node as ccTasks, and
// the main agent's on the list itself. The rows draw them hanging below (__ccUnder): agents branch
// to the side, tasks hang under whoever started them. Tasks of an agent not in the tree are left
// for the flat list.
window.__ccTree=(s,roots)=>{try{
  const b=books.get(s);if(!b||!b.recs.size)return roots;
  const id=sid(s),nodes=new Map(),walk=(list)=>{for(const n of list)if(n&&n.agent){nodes.set(n.agent.taskId,n);walk(n.children||[])}};
  walk(roots);
  const out=roots.slice(),under=new Map();
  for(const r of b.recs.values()){
    r.placed=false;
    if(!r.bg||(r.sid&&id&&r.sid!==id))continue;
    look(s,b,r);
    const owner=r.parent||r.owner,node=owner==="main"?out:nodes.get(owner);
    if(!node)continue;
    r.placed=true;
    if(!under.has(node))under.set(node,[]);
    under.get(node).push(entry(s,r));
  }
  for(const [node,list] of under)node.ccTasks=list.sort(order);
  return out;
}catch(e){return roots}};
// A row with tasks hanging below it, each drawn by the map's own agent row. The map centres each
// row on its branch of agents, which a list under the row would knock out of line with the
// connectors, so while the tree holds any tasks it is drawn top-aligned instead: every row at the
// top of its branch, the connectors at row height. Trees without tasks keep the native look.
// Class names are the map's own (hashed per release), so the styles are built from them.
let styled="";
const styleFor=(cls)=>{
  const key=cls.tree+cls.node;
  if(styled!==key){
    styled=key;
    const T="."+cls.tree+":has(.cc-stack)",N="."+cls.node,C="."+cls.children,H="."+cls.child,mid="var(--cc-row-mid,23px)",line="var(--app-input-border)";
    let el=document.getElementById("cc-task-styles");
    if(!el){el=document.createElement("style");el.id="cc-task-styles";document.head.appendChild(el)}
    el.textContent=[
      T+" "+N+"{align-items:flex-start}",
      T+" "+C+":before,"+T+" "+H+":before{top:"+mid+"}",
      T+" "+H+":first-child:after{top:"+mid+"}",
      T+" "+H+":last-child:after{top:0;bottom:auto;height:"+mid+"}",
      ".cc-stack{flex-direction:column;align-items:flex-start}",
      ".cc-stack.cc-main{position:sticky;z-index:1;top:0;bottom:0}",
      ".cc-hang{display:flex;flex-direction:column;gap:8px;margin:8px 0 0 32px}",
      // Indented by 32px, so 32px narrower than the row above (the map's rows are 300px, the
      // session row 320px): the right edges line up and the connectors to the side still meet.
      ".cc-hang "+N+">."+cls.row+"{width:268px}",
      ".cc-main .cc-hang "+N+">."+cls.row+"{width:288px}",
      ".cc-task{position:relative}",
      ".cc-task:before,.cc-task:after{content:\"\";position:absolute;background:"+line+";left:-16px}",
      ".cc-task:before{height:1px;width:16px;top:50%}",
      ".cc-task:after{width:1px;top:-8px;bottom:-8px}",
      ".cc-task:last-child:after{bottom:50%}",
    ].join("\n");
  }
  // Rows are two lines high; measure one so the connectors meet its middle at any font size.
  requestAnimationFrame(()=>{try{
    const row=document.querySelector("."+cls.tree+" ."+cls.row);
    if(row&&row.offsetHeight)document.documentElement.style.setProperty("--cc-row-mid",row.offsetHeight/2+"px");
  }catch(e){}});
};
window.__ccUnder=(row,tasks,jsx,Row,cls,waiting,pick,main)=>{try{
  if(!tasks||!tasks.length||!jsx||!Row||!cls||!cls.node)return row;
  styleFor(cls);
  return jsx("div",{className:cls.node+" cc-stack"+(main?" cc-main":""),children:[row,
    jsx("div",{className:"cc-hang",children:tasks.map((t)=>jsx("div",{className:"cc-task",children:
      jsx("div",{className:cls.node,children:jsx(Row,{agent:t,waiting,onClick:()=>pick(t.taskId)})})},t.taskId))})]});
}catch(e){return row}};
// Read by the map while it renders, so it redraws when a task changes or a lookup lands.
window.__ccTaskVer=(s)=>{try{const b=book(s);return b.sig?b.sig.value:0}catch(e){return 0}};
// A click on a task's node opens the task card instead of an agent card.
window.__ccTaskPick=(key)=>{const r=byId.get(key);return r&&r.bg?{kind:"task",taskId:key}:null};
// The flat list keeps only the tasks the tree could not place.
window.__ccLoose=(tasks)=>{try{
  let out=null;
  for(const k of tasks.keys()){const r=byId.get(k);if(r&&r.placed){out=out||new Map(tasks);out.delete(k)}}
  return out||tasks;
}catch(e){return tasks}};
// The card of a task that ended before it was opened: the panel no longer has it.
window.__ccTaskRec=(id)=>{const r=byId.get(id);return r&&r.bg?{taskId:id,taskType:r.taskType,description:r.description}:void 0};
// Added to the task card: who started it, and the command it runs.
window.__ccTaskInfo=(s,task,jsx,cls)=>{try{
  const b=books.get(s),r=b&&task&&b.recs.get(task.taskId);
  if(!r)return null;
  if(b.sig)b.sig.value; // redraw the card when the lookup lands
  look(s,b,r);
  const out=[],owner=r.parent||r.owner;
  if(owner){
    const a=owner==="main"?null:(window.__ccAgents?window.__ccAgents(s):s.agentMapAgents.peek()).get(owner);
    out.push(jsx("div",{className:cls.meta,children:["Started by ",owner==="main"?"the main agent":a?a.description:"a subagent"]},"cc-by"));
  }
  if(r.cmd)out.push(jsx("pre",{className:cls.prompt,children:"$ "+r.cmd},"cc-cmd"));
  return out;
}catch(e){return null}};
}
// Once the turn's prompt is known: a record already there means the turn began before a
// reload, and its starting total is the right one; otherwise record ours.
const keep=(st)=>{const r=load(TK+st.key);if(r&&r.b)st.base=r.b;else if(st.base)save(TK+st.key,{b:st.base})};
const begin=(s,st,key)=>{
  const id=sid(s),last=st.cum||(id&&load(SK+id)&&load(SK+id).c);
  // A session with no replies yet is a fresh one, whose running total starts at zero.
  st.base=last||(s.messages.value.some((m)=>m.type==="assistant")?null:[0,0]);
  st.key=key||null;
  if(st.key)keep(st);
};
// Called with every frame from the CLI, before the panel handles it.
window.__ccFrame=(s,f)=>{try{
  if(f&&f.type==="system"){workflowFrame(s,f);if(window.__ccTaskFrame)window.__ccTaskFrame(s,f)}
  if(!f||f.type!=="result"||!f.modelUsage)return;
  const c=fromModels(f.modelUsage),st=sessions.get(s),id=sid(s);
  if(id)save(SK+id,{c});
  if(!st)return;
  if(!st.key&&st.start){const p=opener(s,st);if(p&&p.uuid){st.key=p.uuid;keep(st)}}
  // A total below the start means the running count was reset (/clear, a new process).
  const b=st.base;
  if(st.key&&b&&c[0]>=b[0]&&c[1]>=b[1]){save(TK+st.key,{b,t:[c[0]-b[0],c[1]-b[1]]});cache.delete(s.messages.value)}
  st.cum=c;
}catch(e){}};
const tokensFor=(start,rows)=>{
  const r=load(TK+start.uuid);
  if(r&&r.t)return r.t;
  let o=0,a=0;
  for(const u of rows.values()){const t=fromRow(u);o+=t[0];a+=t[1]}
  return a>0?[o,a]:null;
};
// A turn's working time: what this webview measured for it (every stretch of it, summed under
// the prompt that opened it), or else its stretches from timestamps, each from the row that
// opened it to its last reply.
const active=(st,t)=>{
  const ms=st&&st.measured.get(t.start.uuid);
  if(ms!=null)return ms;
  let sum=0;for(const [open,last] of t.spans)if(last)sum+=at(last)-at(open);
  return sum;
};
// The messages as turns: {start, last, rows, spans}. A notification row (only present after a
// reload) opens a new stretch of the turn before it; one with no turn before it starts a turn.
// Subagent messages carry a parent tool id, so they never start, end or stretch a turn;
// their own rows keep the native timer.
// A prompt typed while I'm already working is held in heldPrompts and absorbed into the
// running turn. appendPickedUp pushes it into messages without the foldedIntoTurn flag that
// the replay path sets, and the finished row carries no marker, so it is indistinguishable
// from a fresh prompt by shape alone. We instead record it live (see the busy subscription):
// any boundary prompt that shows up while a turn is already running is absorbed, not a start.
const turns=(st,msgs)=>{
  const out=[];let t=null;
  for(const m of msgs){
    if((isBoundary(m)||!t&&isResume(m))&&!isAbsorbed(m,st)){t={start:m,last:null,rows:new Map(),spans:[[m,null]]};out.push(t)}
    else if(t&&isResume(m))t.spans.push([m,null]);
    else if(t&&m.type==="assistant"&&top(m)){
      if(!m.isEmpty)t.last=t.spans[t.spans.length-1][1]=m;
      // One reply split across rows repeats its usage on each, so count it once.
      if(m.ccUsage)t.rows.set(m.betaMessageId||m.uuid,m.ccUsage);
    }
  }
  return out;
};
const labels=(s)=>{
  // A turn held open by background subagents is still running even while the parent is idle.
  const st=sessions.get(s),msgs=s.messages.value,busy=s.busy.value||!!(st&&st.start),hit=cache.get(msgs);
  if(hit&&hit.busy===busy)return hit.map;
  const map=new Map(),all=turns(st,msgs);
  all.forEach((t,i)=>{
    if(!t.last||(i===all.length-1&&busy))return;
    const ms=active(st,t);
    if(ms>=1000&&isFinite(ms))map.set(t.last.uuid||t.last,{ms,tok:tokensFor(t.start,t.rows)});
  });
  cache.set(msgs,{busy,map});return map;
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
  el.textContent="Working for "+fmt(st.prior+Date.now()-st.start);
}catch(e){}};
setInterval(paint,1000);
// Called from the main chat view's render with its session.
window.__ccTurnTimer=(s)=>{try{
  current=s;
  if(!sessions.has(s)){
    // prior: when the running stretch continues an earlier turn, that turn's time before it.
    const st={start:0,len:0,measured:new Map(),absorbed:new Set(),seen:new Set(),everBusy:false,endTimer:0,cum:null,base:null,key:null,prior:0};sessions.set(s,st);
    const markSeen=()=>{try{for(const m of s.messages.value)if(m.uuid)st.seen.add(m.uuid)}catch(e){}};
    // The parent usually ends its own turn seconds after launching background subagents, and
    // each one reports back later in a turn of its own. The extension counts the session as
    // running while any are alive (busy || backgroundTaskIds), and so does the clock.
    const agentsRunning=()=>{try{const ids=s.backgroundTaskIds&&s.backgroundTaskIds.value;return !!(ids&&ids.size>0)}catch(e){return false}};
    const finish=(endedAt)=>{
      clearTimeout(st.endTimer);st.endTimer=0;
      // The whole turn's time so far goes under its prompt, so a continuation adds to it.
      const ms=st.prior+(endedAt-st.start),msgs=s.messages.value,p=st.key?null:opener(s,st),key=st.key||(p&&p.uuid);st.start=0;st.prior=0;
      if(key)st.measured.set(key,ms);
      markSeen();
      cache.delete(msgs);
    };
    // Prompts already present when the turn began; anything boundary-shaped that appears
    // after this while busy was typed mid-turn and folded into the running turn. One sent
    // while the parent is idle and only subagents hold the turn open is a new turn instead:
    // it was never queued, and the history rebuilt after a reload splits it off too.
    const noteAbsorbed=()=>{try{
      if(!st.start)return;
      const msgs=s.messages.value;
      for(const m of msgs){
        if(!m.uuid||st.seen.has(m.uuid)||m.isQueuedCommand===true||!isBoundary(m))continue;
        if(s.busy.value){st.absorbed.add(m.uuid);cache.delete(msgs);continue}
        const now=Date.now(),t=at(m);
        finish(now);
        st.start=(t!=null&&isFinite(t)&&t<=now&&now-t<5000)?t:now;
        st.len=msgs.indexOf(m)+1;
        begin(s,st,m.uuid);
      }
    }catch(e){}};
    s.messages.subscribe(()=>{noteAbsorbed()});
    const update=(fromAgents)=>{try{
      if(s.busy.value||agentsRunning()){
        if(st.endTimer){clearTimeout(st.endTimer);st.endTimer=0}
        if(st.start)return setTimeout(paint,0);
        const now=Date.now(),msgs=s.messages.value;let from=null,opened=null,lastAt=null;
        try{
          // Walk back to the prompt that opened the current turn. Replies and tool traffic
          // sit between it and here, so they are skipped rather than ending the search. The
          // newest row's time says whether anything was happening just before now.
          for(let i=msgs.length-1;i>=0;i--){
            const m=msgs[i],t=at(m);
            if(lastAt==null&&top(m)&&t!=null&&isFinite(t))lastAt=t;
            if(isBoundary(m)&&!isAbsorbed(m,st)){if(t!=null&&isFinite(t)){from=t;opened=m}break}
          }
        }catch(e){}
        const ok=from!=null&&from<=now&&now-from<86400000;
        // The send path appends the prompt row before flipping busy, so a turn that begins
        // with a prompt this webview has not seen is that prompt's own; the row's time is the
        // start when it is recent, else now (a held prompt released, a replayed row).
        // A turn that begins without a new prompt continues the turn of the last one: the
        // report of a background task, which the panel never gets a row for. The clock takes
        // up that turn's time so far and its tokens stay under its prompt.
        // A rebuilt webview has seen nothing: there, activity moments ago means a reload in the
        // middle of the turn, and the prompt's time is the real start; otherwise the earlier
        // stretches are summed from timestamps and this one continues them.
        const firstTurn=st.measured.size===0&&!st.everBusy,isNew=!!opened&&!st.seen.has(opened.uuid);
        markSeen();st.len=msgs.length;st.everBusy=true;st.prior=0;
        if(!opened){st.start=now;begin(s,st,null)}
        else if(firstTurn?ok&&lastAt!=null&&now-lastAt<60000:isNew){
          const recent=ok&&(firstTurn||now-from<5000);
          st.start=recent?from:now;begin(s,st,recent?opened.uuid:null);
        }
        else{
          const all=turns(st,msgs),t=all[all.length-1],ms=t&&t.start===opened?active(st,t):0;
          st.prior=isFinite(ms)?ms:0;st.start=now;begin(s,st,opened.uuid);
        }
      }
      else if(st.start&&!st.endTimer){
        // The last subagent finishing is followed a moment later by the parent's turn that
        // takes its report; wait for it rather than splitting the turn. The duration still
        // ends at the moment the work stopped.
        const endedAt=Date.now();
        if(fromAgents)st.endTimer=setTimeout(()=>{try{finish(endedAt);paint()}catch(e){}},10000);
        else finish(endedAt);
      }
      setTimeout(paint,0);
    }catch(e){}};
    s.busy.subscribe(()=>update(false));
    if(s.backgroundTaskIds)s.backgroundTaskIds.subscribe(()=>update(true));
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
  const turn=labels(s).get(m.uuid||m);
  if(turn==null)return r;
  const tok=turn.tok?" · "+num(turn.tok[0])+" out · "+num(turn.tok[1])+" total":"";
  const a=args.slice();
  a[1]={isEmpty:false,type:"meta",content:[{content:{type:"text",text:"Worked for "+fmt(turn.ms)+tok}}]};
  a[2]="cc-timer-"+(m.uuid||args[2]);
  const label=orig.apply(null,a);
  return r==null?label:[r,label];
}catch(e){return r}};
}catch(e){}})();
