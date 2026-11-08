#!/usr/bin/env node
// Claude Code -> BUSY Bar bridge.
//
// Claude Code hooks POST their JSON payload to /event (loopback only).
// The BUSY Bar app polls GET /status over the network and draws it.
// No dependencies; state lives in memory and rebuilds from the next hook event.

import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.BUSYBAR_BRIDGE_PORT || 7878);
const HOST = process.env.BUSYBAR_BRIDGE_HOST || "0.0.0.0";
const STALE_MS = 6 * 3600 * 1000; // sessions with no events for this long are dropped
const MAX_SESSIONS = 4; // sent to the bar, most urgent first
const DEBUG_EVENTS = 40;

// state -> [urgency, how long it stays relevant in ms (0 = until replaced)]
const STATES = {
  input: [50, 0],
  tool: [40, 30 * 60e3],
  think: [40, 30 * 60e3],
  compact: [40, 30 * 60e3],
  done: [30, 15 * 60e3],
  idle: [20, 15 * 60e3],
  ready: [10, 2 * 60e3],
};

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, any>} session id -> context window breakdown, from the busybar-context mod */
const contexts = new Map();
const recent = []; // raw hook payloads, for /debug

const now = () => Date.now();

/** Bar fonts are bitmap ASCII; anything outside 0x20-0x7E is rejected. */
function ascii(s, limit = 60) {
  const out = String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
  return out.slice(0, limit);
}

function toolDetail(name, input = {}) {
  let n = name || "Tool";
  if (n.startsWith("mcp__")) n = n.split("__").pop();
  let d = "";
  if (input.command) d = input.command;
  else if (input.file_path) d = path.basename(String(input.file_path));
  else if (input.notebook_path) d = path.basename(String(input.notebook_path));
  else if (input.pattern) d = input.pattern;
  else if (input.url) d = String(input.url).replace(/^https?:\/\//, "");
  else if (input.query) d = input.query;
  else if (input.description) d = input.description;
  else if (input.subject) d = input.subject;
  return ascii(`${n} ${d}`);
}

// ---------------------------------------------------------------- tasks

/** Task list mirrored from TodoWrite or TaskCreate/TaskUpdate calls. */
function taskEvent(s, ev) {
  const name = ev.tool_name;
  const input = ev.tool_input || {};
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    s.tasks = input.todos.map((t, i) => ({
      id: String(t.id ?? i + 1),
      status: t.status,
      label: t.activeForm || t.content || "",
      subject: t.content || t.activeForm || "",
    }));
    return;
  }
  if (ev.hook_event_name !== "PostToolUse") return; // only count calls that ran
  const resp = ev.tool_response || {};
  if (name === "TaskCreate") {
    const id =
      resp?.task?.id ?? resp?.id ?? resp?.taskId ?? String((s.taskSeq = (s.taskSeq || 0) + 1));
    s.tasks = (s.tasks || []).filter((t) => t.id !== String(id));
    s.tasks.push({
      id: String(id),
      status: "pending",
      label: input.activeForm || input.subject || "",
      subject: input.subject || "",
    });
  } else if (name === "TaskUpdate" && input.taskId != null) {
    const t = (s.tasks || []).find((x) => x.id === String(input.taskId));
    if (!t) return;
    if (input.status === "deleted") {
      s.tasks = s.tasks.filter((x) => x !== t);
      return;
    }
    if (input.status) t.status = input.status;
    if (input.activeForm) t.label = input.activeForm;
    if (input.subject) t.subject = input.subject;
  }
}

function progress(s) {
  const tasks = s.tasks || [];
  if (!tasks.length) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  const current = tasks.find((t) => t.status === "in_progress");
  return { done, total: tasks.length, task: current ? ascii(current.label || current.subject) : "" };
}

// ---------------------------------------------------------------- context window

// /context colours rows by Claude Code theme key; the bar needs #RRGGBBAA.
const THEME = {
  claude: "#D97757FF",
  promptBorder: "#888888FF",
  inactive: "#666666FF",
  permission: "#B1B9F9FF",
  warning: "#FFC107FF",
  success: "#4EBA65FF",
  error: "#FF6B80FF",
  suggestion: "#B1B9F9FF",
  remember: "#B1B9F9FF",
  planMode: "#48968CFF",
  autoAccept: "#AF87FFFF",
  bashBorder: "#FD5DB1FF",
  ide: "#4782C8FF",
  purple: "#AF87FFFF",
  cyan: "#64D2FFFF",
  red: "#FF3B30FF",
  green: "#34C759FF",
  blue: "#0A84FFFF",
  yellow: "#FFCC00FF",
  magenta: "#FF2D95FF",
  orange: "#FF9500FF",
};
const FALLBACK = ["#64D2FFFF", "#AF87FFFF", "#FFCC00FF", "#34C759FF", "#FF9500FF", "#FF2D95FF", "#0A84FFFF"];

const SHORT = {
  "System prompt": "System",
  "System tools": "Tools",
  "MCP tools": "MCP",
  "MCP server instructions": "MCP info",
  "Custom agents": "Agents",
  "Memory files": "Memory",
};

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** Compact form for the bar: used rows as [tokens, colour], the reserve, and a legend line. */
function compactContext(c) {
  const used = c.categories.filter((x) => x.kind === "used");
  // Subagent colours come as e.g. "purple_FOR_SUBAGENTS_ONLY".
  const color = (x, i) => THEME[String(x.color).replace(/_FOR_SUBAGENTS_ONLY$/, "")] || FALLBACK[i % FALLBACK.length];
  const seg = used.map((x, i) => [x.tokens, color(x, i)]);
  const buffer = c.categories.filter((x) => x.kind === "buffer").reduce((n, x) => n + x.tokens, 0);
  const legend = [...used]
    .sort((a, b) => b.tokens - a.tokens)
    .map((x) => `${SHORT[x.name] || x.name} ${fmtTokens(x.tokens)}`)
    .join(", ");
  return {
    pct: Math.round(c.percentage),
    lbl: `${fmtTokens(c.total)}/${fmtTokens(c.max)}`,
    max: c.max,
    seg,
    buf: buffer,
    leg: ascii(legend, 120),
  };
}

// ---------------------------------------------------------------- events

function applyEvent(ev) {
  const sid = ev.session_id || "default";
  const name = ev.hook_event_name || "";
  const t = now();

  if (name === "SessionEnd") {
    sessions.delete(sid);
    contexts.delete(sid);
    return;
  }

  const s = sessions.get(sid) || { started: t, state: "ready", detail: "" };
  sessions.set(sid, s);
  s.project = ascii(path.basename(String(ev.cwd || "").replace(/\/+$/, "")), 32) || "claude";
  s.updated = t;

  switch (name) {
    case "SessionStart":
      Object.assign(s, { state: "ready", detail: "", turnStart: null });
      // "resume" and "compact" keep the conversation, and with it the task list.
      if (ev.source === "startup" || ev.source === "clear") s.tasks = [];
      break;
    case "UserPromptSubmit":
      Object.assign(s, { state: "think", detail: "", turnStart: t, took: null });
      break;
    case "PreToolUse":
      taskEvent(s, ev);
      Object.assign(s, { state: "tool", detail: toolDetail(ev.tool_name, ev.tool_input) });
      s.turnStart ??= t;
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
      taskEvent(s, ev);
      if (s.state === "tool" || s.state === "input") Object.assign(s, { state: "think", detail: "" });
      break;
    case "SubagentStop":
      if (s.state === "input") Object.assign(s, { state: "think", detail: "" });
      break;
    case "PreCompact":
      Object.assign(s, { state: "compact", detail: "" });
      break;
    case "Notification": {
      const kind = ev.notification_type || "";
      const msg = String(ev.message || "");
      if (kind === "idle_prompt" || /waiting for your input/i.test(msg)) {
        if (s.state !== "input") Object.assign(s, { state: "idle", detail: "" });
      } else if (kind === "permission_prompt" || kind === "elicitation_dialog" || !kind) {
        Object.assign(s, { state: "input", detail: ascii(msg) });
      }
      break;
    }
    case "Stop":
      Object.assign(s, {
        state: "done",
        detail: "",
        took: s.turnStart ? Math.round((t - s.turnStart) / 1000) : null,
        turnStart: null,
      });
      break;
  }
}

// ---------------------------------------------------------------- status

function liveSessions() {
  const t = now();
  const out = [];
  for (const [sid, s] of sessions) {
    if (t - s.updated > STALE_MS) {
      sessions.delete(sid);
      contexts.delete(sid);
      continue;
    }
    const [urgency, ttl] = STATES[s.state] || [0, 1];
    // An expired state (e.g. "done" an hour ago) ranks below anything current.
    const expired = ttl && t - s.updated > ttl;
    out.push({ s, sid, rank: expired ? 0 : urgency });
  }
  out.sort((a, b) => b.rank - a.rank || b.s.updated - a.s.updated);
  return out.slice(0, MAX_SESSIONS).map(({ s, sid, rank }) => {
    const p = progress(s);
    // Compact keys: the bar has a 128 KiB heap.
    const o = { p: s.project, s: rank ? s.state : "idle" };
    if (s.detail) o.d = s.detail;
    if (s.turnStart) o.t = Math.floor(s.turnStart / 1000);
    if (s.state === "done" && s.took != null) o.k = s.took;
    if (p) Object.assign(o, { n: p.done, of: p.total, task: p.task });
    const ctx = contexts.get(sid);
    if (ctx) o.c = compactContext(ctx);
    return o;
  });
}

// ---------------------------------------------------------------- http

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function isPrivate(req) {
  const a = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return (
    isLoopback(req) ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) ||
    /^f[cd]/i.test(a)
  );
}

function send(res, code, body) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

/** Reads a JSON body, hands it to `apply`, answers 200, or 400 if either fails. */
function readJson(req, res, apply) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 1e6) req.destroy();
  });
  req.on("end", () => {
    try {
      apply(JSON.parse(raw || "{}"));
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { error: String(e) });
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (!isPrivate(req)) return send(res, 403, { error: "forbidden" });

  if (req.method === "GET" && url.pathname === "/status") {
    return send(res, 200, { now: Math.floor(now() / 1000), sessions: liveSessions() });
  }
  if (req.method === "GET" && url.pathname === "/debug" && isLoopback(req)) {
    return send(res, 200, { sessions: Object.fromEntries(sessions), contexts: Object.fromEntries(contexts), recent });
  }
  if (req.method === "POST" && url.pathname === "/context" && isLoopback(req)) {
    // From the busybar-context mod: the session's context window breakdown.
    return readJson(req, res, (c) => {
      if (!c.session_id || !Array.isArray(c.categories) || !c.max) throw new Error("bad context");
      contexts.delete(c.session_id); // re-insert last, so the oldest go first below
      if (contexts.size >= 32) contexts.delete(contexts.keys().next().value);
      contexts.set(c.session_id, { total: c.total, max: c.max, percentage: c.percentage, categories: c.categories });
    });
  }
  if (req.method === "POST" && url.pathname === "/event" && isLoopback(req)) {
    return readJson(req, res, (ev) => {
      recent.push({ at: new Date().toISOString(), ev });
      if (recent.length > DEBUG_EVENTS) recent.shift();
      applyEvent(ev);
    });
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  console.log(`busybar bridge on ${HOST}:${PORT} (${ips.join(", ")})`);
});
