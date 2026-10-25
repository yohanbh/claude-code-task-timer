// The "Claude Subagents" view: every subagent of recent Claude Code sessions, plain Agent-tool
// subagents and Workflow-tool agents alike, with a live transcript tab for each. All of it is
// read from the transcripts on disk by scan.js, in a worker thread (see worker.js), so nothing
// here depends on the Claude Code extension's internals, and its updates cannot break it.

const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { fmt, num } = require("./scan");

const ICONS = {
  running: ["sync~spin"],
  done: ["pass", "testing.iconPassed"],
  completed: ["pass", "testing.iconPassed"],
  inactive: ["circle-slash", "disabledForeground"],
};
// Any other state comes from a run summary and has not been seen working, so it is shown as failed.
const icon = (state) => {
  const [id, color] = ICONS[state] || ["error", "testing.iconFailed"];
  return new vscode.ThemeIcon(id, color && new vscode.ThemeColor(color));
};
const { Expanded, Collapsed, None } = vscode.TreeItemCollapsibleState;

// Session -> workflow run -> phase (only when a run has several) -> agent, as the worker built it.
class Tree {
  constructor() {
    this.sessions = [];
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  update(sessions) {
    this.sessions = sessions;
    this.emitter.fire();
  }

  getChildren(e) {
    return e ? e.children || [] : this.sessions;
  }

  // Expanded/Collapsed only applies the first time an id is seen; after that the view keeps
  // whatever the user chose.
  getTreeItem(e) {
    if (e.kind === "session") {
      const item = new vscode.TreeItem(e.project, e === this.sessions[0] ? Expanded : Collapsed);
      item.id = e.dir;
      const at = new Date(e.mtime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      item.description = [e.id.slice(0, 8), `active ${at}`, e.running && `${e.running} running`].filter(Boolean).join(" · ");
      item.tooltip = e.dir;
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      return item;
    }
    if (e.kind === "run") {
      const item = new vscode.TreeItem(e.name, e.state === "running" ? Expanded : Collapsed);
      item.id = e.dir;
      item.description = `${e.done}/${e.total} · ${fmt(e.elapsedMs)} · ${num(e.tokens)} tok`;
      item.tooltip = `Workflow ${e.name} (${e.id}): ${e.state}\n${e.done} of ${e.total} agents done`;
      item.iconPath = icon(e.state);
      return item;
    }
    if (e.kind === "phase") {
      const item = new vscode.TreeItem(e.title, Expanded);
      item.id = e.id;
      item.description = [e.running && `${e.running} running`, `${e.done}/${e.total} done`].filter(Boolean).join(" · ");
      return item;
    }
    const item = new vscode.TreeItem(e.label, None);
    item.id = e.file;
    item.description = [fmt(e.elapsedMs), `${num(e.tokens)} tok`, e.lastTool].filter(Boolean).join(" · ");
    item.tooltip = [
      `${e.label}: ${e.state}`,
      [e.phase && `phase ${e.phase}`, e.agentType, e.model].filter(Boolean).join(", "),
      `${fmt(e.elapsedMs)}, ${e.toolCalls} tool calls, ${e.tokens.toLocaleString()} tokens in the latest request`,
      e.lastTool && `Last tool: ${e.lastTool}`,
      e.file,
    ]
      .filter(Boolean)
      .join("\n");
    item.iconPath = icon(e.state);
    item.command = { command: "claudeSubagents.open", title: "Open Transcript", arguments: [e] };
    return item;
  }
}

function activate(context) {
  const tree = new Tree();
  const view = vscode.window.createTreeView("claudeSubagents", { treeDataProvider: tree, showCollapseAll: true });
  view.message = "Reading transcripts…";
  const panels = new Map(); // transcript file -> its webview panel
  const worker = new Worker(path.join(__dirname, "worker.js"));

  worker.on("message", (m) => {
    if (m.sessions) {
      view.message = m.sessions.length ? undefined : "No subagents in Claude Code sessions from the last 12 hours.";
      tree.update(m.sessions);
    }
    if (m.entries) panels.get(m.file)?.webview.postMessage({ entries: m.entries });
    if (m.error) console.error(`[claude-subagent-viewer] ${m.error}`);
  });
  worker.on("error", (e) => console.error("[claude-subagent-viewer]", e));
  worker.postMessage({ active: view.visible });

  const open = (agent) => {
    const old = panels.get(agent.file);
    if (old) return old.reveal();
    const panel = vscode.window.createWebviewPanel("claudeSubagentTranscript", agent.label, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panels.set(agent.file, panel);
    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.html = fs.readFileSync(path.join(__dirname, "transcript.html"), "utf8").replace(/\{\{nonce\}\}/g, nonce);
    // The page says when it is ready, and the worker then streams the whole transcript into it
    // from the start, followed by each addition.
    panel.webview.onDidReceiveMessage((m) => {
      if (!m.ready) return;
      panel.webview.postMessage({ header: { title: agent.label, file: agent.file } });
      worker.postMessage({ open: agent.file });
    });
    panel.onDidDispose(() => {
      panels.delete(agent.file);
      worker.postMessage({ close: agent.file });
    });
  };

  context.subscriptions.push(
    view,
    view.onDidChangeVisibility((e) => worker.postMessage({ active: e.visible })),
    vscode.commands.registerCommand("claudeSubagents.open", open),
    { dispose: () => worker.terminate() },
  );
}

module.exports = { activate };
