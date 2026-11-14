// The popped-out map's page. It builds lot-map's board from the events mapfeed.js reads out of the
// session's transcripts, following the rules of lot-map's hooks/register.tsx (begin, finish, settle,
// what a turn, a step and a call do to the board), and draws it with lot-map's own drawMap.
// The transcript says less than the hooks lot-map listens to: a hook's refusal is read from the
// refused call's error text, and the context percentage is the latest request's size over the
// window set in `claudeMap.contextWindow`.

import { drawMap } from './map/draw.js'
import { setupFrom } from './map/setup.js'
import { classify, clean, formatMs, shortModel } from './map/classify.js'
import { foldRows, nowParts, taskNotice, taskOf } from './map/feed.js'

const KEEP = 80
const CREW = 12
const ACTIVE_MS = 65_000 // trails hold 40 s and fade over 20 s; the map moves until then
const vscode = acquireVsCodeApi()

const mapEl = document.getElementById('map')
const nowEl = document.getElementById('now')
const feedEl = document.getElementById('feed')
const headEl = document.getElementById('head')
const sideEl = document.getElementById('side')
const moreEl = document.getElementById('more')
// The log shows the newest few rows; the button opens the rest of the history and closes it again.
const FEW_ROWS = 7
const MORE_ROWS = 60
let expanded = false

// Claude orange for lot-map's accent and its brighter "active" shade; its other colors stay.
const base = setupFrom({ colors: 'accent=#d97757, active=#eb9a7e' })
const t = base.t
let setup = base
let contextWindow = 500_000
let board, st
let changedAt = 0
let dirty = true

function reset() {
  board = { entries: [], counts: {} }
  st = {
    steps: new Map(), // loop ('' = main, else agent id) -> its open model step's entry id
    stepNo: new Map(), // loop -> steps so far in its turn
    pending: new Map(), // loop -> tool_use ids not yet answered
    tools: new Map(), // tool_use id -> { entry, name }
    seen: new Set(), // reply ids already counted
    done: new Set(), // reply ids that ended a turn
    model: undefined, // the main loop's model
    seq: 0,
  }
}
reset()

const touch = at => {
  changedAt = Math.max(changedAt, at ?? 0, Date.now() - ACTIVE_MS + 1000)
  dirty = true
}
const isFault = s => s === 'err' || s === 'block'
const oneMore = (faults, station) => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })
const kept = entries => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}
const pendingOf = loop => st.pending.get(loop) ?? st.pending.set(loop, new Set()).get(loop)

function begin(start, now) {
  const entry = {
    id: `e${++st.seq}`,
    station: start.station,
    label: clean(start.label),
    from: start.from ?? 'core',
    startedAt: now,
    status: start.status ?? 'run',
    ...(start.status !== undefined ? { endedAt: now } : {}),
    ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
    ...(start.mark !== undefined ? { mark: start.mark } : {}),
  }
  const b = board
  board = {
    ...b,
    ...start.patch,
    entries: kept([...b.entries, entry]),
    counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
    ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
    ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId) ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) } : {}),
  }
  touch(now)
  return entry.id
}

function finish(id, status, now, patch) {
  const open = board.entries.find(e => e.id === id && e.status === 'run')
  if (open === undefined) return
  board = {
    ...board,
    ...patch,
    entries: board.entries.map(e => (e === open ? { ...e, ...(patch?.label ? { label: patch.label } : {}), status, endedAt: now } : e)),
    ...(isFault(status) ? { faults: oneMore(board.faults, open.station) } : {}),
  }
  delete board.label
  touch(now)
}

function settle(task, status, now) {
  const open = board.entries.find(e => e.task === task && e.status === 'run')
  if (open === undefined) return
  board = {
    ...board,
    entries: board.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
    ...(isFault(status) ? { faults: oneMore(board.faults, open.station) } : {}),
  }
  touch(now)
}

// Ends every call of the main loop still open, as an answer or an interruption does.
function closeMain(now) {
  board = { ...board, entries: board.entries.map(x => (x.status === 'run' && x.from === 'core' && x.task === undefined ? { ...x, status: 'ok', endedAt: now } : x)) }
  st.steps.delete('')
  pendingOf('').clear()
}

const stepLabel = (model, n, loop) => `${model ? `${shortModel(model)} · ` : ''}${t.step(n)}${loop ? ` · ${t.subagent}` : ''}`

// The model is asked: after a message, or once every call it made has answered.
function openStep(loop, now) {
  if (st.steps.has(loop)) return
  const n = (st.stepNo.get(loop) ?? 0) + 1
  st.stepNo.set(loop, n)
  const id = begin(
    { station: 'model', label: stepLabel(loop ? undefined : st.model, n, loop), from: loop ? 'agents' : 'core', ...(loop ? { agentId: loop } : { patch: { step: n } }) },
    now,
  )
  st.steps.set(loop, id)
}

function closeStep(loop, now, e) {
  const id = st.steps.get(loop)
  if (id === undefined) return
  st.steps.delete(loop)
  const label = clean(stepLabel(e.model, st.stepNo.get(loop) ?? 1, loop))
  const context = loop || !e.tok ? {} : { context: Math.min(100, (e.tok / contextWindow) * 100) }
  finish(id, 'ok', now, { label, ...context })
}

function agentDone(agent, now) {
  board = {
    ...board,
    agents: (board.agents ?? []).filter(id => id !== agent),
    entries: board.entries.map(x => (x.status === 'run' && (x.agentId === agent || x.task === agent) ? { ...x, status: 'ok', endedAt: now } : x)),
  }
  st.steps.delete(agent)
  touch(now)
}

function apply(e) {
  const now = e.t ?? Date.now()
  const loop = e.a ?? ''
  switch (e.k) {
    case 'prompt':
      if (loop) return openStep(loop, now) // a subagent's task
      board = { ...board, faults: {} }
      begin({ station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' }, now)
      st.stepNo.set('', 0)
      return openStep('', now)
    case 'notice': {
      const notice = taskNotice(e.text)
      if (notice?.status !== undefined) {
        settle(notice.id, notice.status, now)
        // A background subagent's report: its task id is its agent id.
        if ((board.agents ?? []).includes(notice.id)) agentDone(notice.id, now)
      }
      if (e.turn && !loop) openStep('', now)
      return
    }
    case 'step': {
      if (!loop && e.model && e.model !== st.model) {
        if (st.model !== undefined) {
          begin({ station: 'model', label: `${shortModel(st.model)} → ${shortModel(e.model)}`, status: 'ok', mark: 'switch', uncounted: true, patch: { switchedAt: now } }, now)
        }
        st.model = e.model
        board = { ...board, model: e.model }
      }
      // A reply whose request was never seen opening (the transcript began mid-turn) still counts once.
      if (!st.seen.has(e.id)) {
        st.seen.add(e.id)
        if (!st.steps.has(loop)) openStep(loop, now)
      }
      const ends = e.stop === 'end_turn' && e.text
      if (e.tools.length > 0 || ends) closeStep(loop, now, e)
      for (const tool of e.tools) {
        if (st.tools.has(tool.id)) continue
        // lot-map does not know the subagent's hand-back call and would file it under Shell.
        const seen = tool.name === 'SubagentHandback' ? { station: 'agents', label: 'report back' } : classify(tool.name, tool.input, setup)
        const entry = begin({ ...seen, from: loop ? 'agents' : 'core', ...(loop ? { agentId: loop } : {}) }, now)
        st.tools.set(tool.id, { entry, name: tool.name })
        pendingOf(loop).add(tool.id)
      }
      if (ends && !st.done.has(e.id)) {
        st.done.add(e.id)
        if (loop) return agentDone(loop, now)
        begin({ station: 'you', label: t.answerReady, status: 'ok', mark: 'done' }, now)
        closeMain(now)
      }
      return
    }
    case 'result': {
      const call = st.tools.get(e.id)
      if (call === undefined) return
      const pending = pendingOf(loop)
      pending.delete(e.id)
      const status = e.block ? 'block' : e.err ? 'err' : 'ok'
      if (e.block && e.hook) begin({ station: 'hooks', label: t.stopped(call.name), status: 'block' }, now)
      const task = status === 'ok' ? taskOf(e.res) : undefined
      if (task !== undefined) {
        board = { ...board, entries: board.entries.map(x => (x.id === call.entry && x.status === 'run' ? { ...x, task } : x)) }
        touch(now)
      } else finish(call.entry, status, now)
      // A subagent that hands its report back by a tool call ends there, with no reply after it.
      if (loop && call.name === 'SubagentHandback') return agentDone(loop, now)
      // A foreground subagent's call answers when the subagent is done.
      if (call.name === 'Agent' && task === undefined && e.res?.agentId) agentDone(e.res.agentId, now)
      if (pending.size === 0) openStep(loop, now)
      return
    }
    case 'abort':
      if (loop) return
      begin({ station: 'you', label: t.turnAborted, status: 'err' }, now)
      return closeMain(now)
    case 'hookctx':
      return void begin({ station: 'hooks', label: t.addedContext(e.start ? t.atStart : t.toMessage), status: 'ok' }, now)
    case 'hookslow':
      return void begin({ station: 'hooks', label: t.checkBefore(e.tool), status: 'ok' }, now)
    case 'compact':
      return void begin({ station: 'model', label: t.compacting, status: 'ok' }, now)
  }
}

// ---- drawing ------------------------------------------------------------------------------------

function themed() {
  const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')
  setup = { ...base, theme: light ? 'light' : 'dark' }
  dirty = true
}
new MutationObserver(themed).observe(document.body, { attributes: true, attributeFilter: ['class'] })
themed()

const column = () => Math.max(8, ...Object.values(t.stations).map(name => name.length))

function drawFeed() {
  const turnMs = new Map()
  let askedAt
  for (const x of board.entries) {
    if (x.station === 'you' && x.from === 'inbound' && x.mark === undefined) askedAt = x.startedAt
    if (x.mark === 'done' && askedAt !== undefined) {
      turnMs.set(x.id, x.startedAt - askedAt)
      askedAt = undefined
    }
  }
  const pad = column()
  const all = foldRows(board.entries, MORE_ROWS)
  moreEl.hidden = all.length <= FEW_ROWS
  moreEl.textContent = expanded ? 'Show less' : 'Show more history'
  const rows = all.slice(0, expanded ? MORE_ROWS : FEW_ROWS).map(({ entry, times, tookMs }) => {
    const isSwitch = entry.mark === 'switch'
    const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
    const whole = turnMs.get(entry.id)
    const took = entry.endedAt === undefined ? t.running : whole !== undefined && whole > 0 ? formatMs(whole, t) : tookMs > 0 ? formatMs(tookMs, t) : '—'
    const row = document.createElement('div')
    row.className = `row ${isSwitch || entry.status === 'run' ? 'hot' : entry.status === 'ok' ? 'dim' : 'bad'}`
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = `${mark} ${t.stations[entry.station].padEnd(pad)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}`
    label.title = entry.label
    const time = document.createElement('span')
    time.className = took === '—' ? 'time moment' : 'time'
    time.textContent = took
    row.append(label, time)
    return row
  })
  if (rows.length === 0) {
    const none = document.createElement('div')
    none.className = 'row dim'
    none.textContent = t.nothingYet
    rows.push(none)
  }
  feedEl.replaceChildren(...rows)
  const { what, meter } = nowParts(board, t)
  nowEl.textContent = what
  nowEl.dataset.meter = meter
}

// The extension answers as it does to a page that just loaded: the worker finds the newest session
// again and replays it from its start, and the board starts over when that session arrives.
document.getElementById('refresh').addEventListener('click', () => {
  headEl.textContent = 'refreshing…'
  vscode.postMessage({ ready: true })
})

moreEl.addEventListener('click', () => {
  expanded = !expanded
  if (!expanded) feedEl.scrollTop = 0
  dirty = true
})

// The divider between the map and the log. The log's share of the window's width is kept in the
// page's state, so it survives the page reloading and follows the window when it is resized.
const splitEl = document.getElementById('split')
const SIDE_DEFAULT = 0.32
const placeSide = share => {
  const s = Math.min(0.8, Math.max(0.12, share))
  sideEl.style.width = `${(s * 100).toFixed(2)}vw`
  return s
}
placeSide(vscode.getState()?.side ?? SIDE_DEFAULT)
splitEl.addEventListener('pointerdown', down => {
  down.preventDefault()
  splitEl.setPointerCapture(down.pointerId)
  splitEl.classList.add('dragging')
  const move = e => placeSide((window.innerWidth - e.clientX) / window.innerWidth)
  const up = e => {
    splitEl.removeEventListener('pointermove', move)
    splitEl.removeEventListener('pointerup', up)
    splitEl.classList.remove('dragging')
    vscode.setState({ ...vscode.getState(), side: move(e) })
  }
  splitEl.addEventListener('pointermove', move)
  splitEl.addEventListener('pointerup', up)
})
splitEl.addEventListener('dblclick', () => vscode.setState({ ...vscode.getState(), side: placeSide(SIDE_DEFAULT) }))

// How often the map is drawn. Pulses fly, ripples spread and spokes glow for a few seconds after a
// call starts or ends (lot-map's PULSE_MS + RIPPLE_MS, GLOW_MS / 2): that needs 30 frames a second.
// A running call's clock hands and fading trails move slowly: 4 a second. Otherwise only on change.
// The agents circling their station spin by themselves (SVG animation), so they need no frames.
const FAST_MS = 3500
let lastFeed = 0
let timer
function frame() {
  clearTimeout(timer)
  if (document.hidden) {
    timer = setTimeout(frame, 1000)
    return
  }
  const now = Date.now()
  const fresh = e => now - e.startedAt < FAST_MS || (e.endedAt !== undefined && now - e.endedAt < FAST_MS)
  const fast = board.entries.slice(-40).some(fresh)
  const slow = fast || board.entries.some(e => e.status === 'run') || now - changedAt < ACTIVE_MS
  if (slow || dirty) mapEl.innerHTML = drawMap(board, now, setup)
  if (dirty || now - lastFeed > 1000) {
    drawFeed()
    lastFeed = now
  }
  dirty = false
  timer = setTimeout(frame, fast ? 33 : slow ? 250 : 1000)
}
document.addEventListener('visibilitychange', () => {
  dirty = true
  frame()
})

window.addEventListener('message', ({ data }) => {
  if (data.contextWindow) {
    contextWindow = data.contextWindow
    dirty = true
  }
  if (data.session) {
    reset()
    headEl.textContent = `${data.session.project} · ${data.session.id.slice(0, 8)}`
    headEl.title = data.session.file
    dirty = true
  }
  for (const e of data.events ?? []) {
    try {
      apply(e)
    } catch (err) {
      console.error('[claude map]', err, e)
    }
  }
  // Drawn now, not when the slow timer next comes round.
  if (dirty) frame()
})

vscode.postMessage({ ready: true })
frame()
