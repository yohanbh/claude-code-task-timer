// The "Claude Subagents" view: every subagent of recent Claude Code sessions, plain Agent-tool
// subagents and Workflow-tool agents alike, with a live transcript tab for each. All of it is
// read from the transcripts on disk by scan.js, in a worker thread (see worker.js), so nothing
// here depends on the Claude Code extension's internals, and its updates cannot break it.

const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
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
    if (m.map) mapPanel?.webview.postMessage(m.map);
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

  // The live map of the newest Claude Code session, drawn with lot-map's own code (see mapview.js),
  // in a window of its own that can go on another monitor.
  let mapPanel;
  const popOutMap = async () => {
    if (mapPanel) return mapPanel.reveal();
    const root = vscode.Uri.file(__dirname);
    mapPanel = vscode.window.createWebviewPanel("claudeMap", "Claude Map", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    const nonce = crypto.randomBytes(16).toString("hex");
    mapPanel.webview.html = fs
      .readFileSync(path.join(__dirname, "map.html"), "utf8")
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{csp\}\}/g, mapPanel.webview.cspSource)
      .replace(/\{\{view\}\}/g, mapPanel.webview.asWebviewUri(vscode.Uri.joinPath(root, "mapview.js")).toString());
    // The page may load again (moving it to another window can reload it); each time it is ready,
    // the worker replays the session to it from the start.
    mapPanel.webview.onDidReceiveMessage((m) => {
      if (!m.ready) return;
      mapPanel.webview.postMessage({ contextWindow: vscode.workspace.getConfiguration("claudeMap").get("contextWindow") });
      worker.postMessage({ map: true });
    });
    mapPanel.onDidDispose(() => {
      mapPanel = undefined;
      worker.postMessage({ map: false });
    });
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
  };

  // agent map (https://github.com/yohanbh/agentmap): a terminal app showing the board, agents and
  // tokens of every Claude session. Like the map above, it opens in a window of its own. Here it is
  // the Linux build in ~/.cargo/bin, so on Windows it runs inside WSL.
  let agentMap;
  const openAgentMap = async () => {
    if (agentMap) return agentMap.show();
    const bin = path.join(os.homedir(), ".cargo", "bin", "agentmap");
    if (process.platform !== "win32" && !fs.existsSync(bin)) {
      return vscode.window.showErrorMessage("agent map isn't installed. Run: cargo install --git https://github.com/yohanbh/agentmap");
    }
    // Made in the terminal panel, then moved with the terminal's own command, which moves the
    // active terminal and nothing else. (Moving the active editor instead can catch whichever
    // editor still has focus, and a terminal already in the editor area cannot be moved this way.)
    agentMap = vscode.window.createTerminal({
      name: "agent map",
      iconPath: new vscode.ThemeIcon("type-hierarchy"),
      location: vscode.TerminalLocation.Panel,
      ...(process.platform === "win32" ? { shellPath: "wsl.exe", shellArgs: ["~/.cargo/bin/agentmap"] } : { shellPath: bin }),
    });
    agentMap.show();
    for (let i = 0; i < 40 && vscode.window.activeTerminal !== agentMap; i++) await new Promise((r) => setTimeout(r, 50));
    if (vscode.window.activeTerminal === agentMap) await vscode.commands.executeCommand("workbench.action.terminal.moveIntoNewWindow");
  };

  context.subscriptions.push(
    view,
    view.onDidChangeVisibility((e) => worker.postMessage({ active: e.visible })),
    vscode.commands.registerCommand("claudeSubagents.open", open),
    vscode.commands.registerCommand("claudeMap.popOut", popOutMap),
    vscode.commands.registerCommand("claudeMap.agentMap", openAgentMap),
    vscode.window.onDidCloseTerminal((t) => {
      if (t === agentMap) agentMap = undefined;
    }),
    { dispose: () => worker.terminate() },
  );
}

module.exports = { activate };
