import { device } from "@shared/device";
import { loadValues } from "@shared/settings";
import { registerFontMaps, textWidth } from "@busy-app/busy-lib";
import { normal, small } from "@busy-app/busy-lib/fonts";
import manifest from "./appmeta/manifest.json";
import claudeAnim from "./animations/claude.anim";

/**
 * Claude Code status for the BUSY Bar.
 *
 * Polls the bridge running on the Mac (bridge/server.mjs), which Claude Code hooks feed,
 * and draws the most urgent session: an animated Claude acting out the state, the current
 * tool or task, task progress and the time the turn has been running.
 */

const APP = manifest.id;

// textWidth() needs the metrics of every font it measures.
registerFontMaps(small);
registerFontMaps(normal);

/** The Mac is 10.0.4.21 on the USB link (the bar is 10.0.4.20). */
const DEFAULT_BRIDGE = "10.0.4.21:7878";

const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15000;

const W = 72;
const SPRITE_W = 16; // claude.anim is 16×16, one section per state (tools/make-claude-anim.mjs)
const TEXT_X = SPRITE_W + 2;
const TEXT_W = W - TEXT_X;

// Rows on the 72×16 screen. Fonts are anchored top_left; tune with screenshots.
const TOP_Y = -1; // small font (5 px caps), first row
const MID_Y = 5; // normal font (7 px caps), second row
const BAR_Y = 15; // 1 px progress bar, below the second row's descenders
const BAR_H = 1;
const CBAR_Y = 6; // context view: 3 px segmented bar between the title and the legend
const CBAR_H = 3;
const LEGEND_Y = 9;

/** How long the context view stays up before going back to the status. */
const CONTEXT_VIEW_MS = 30000;

const DIM = "#FFFFFF90";
const TRACK = "#FFFFFF30";
const ORANGE = "#D97757FF";

/** Session state from the bridge (keys kept short: the heap is small). */
interface Session {
  p: string; // project
  s: "input" | "tool" | "think" | "compact" | "done" | "idle" | "ready";
  d?: string; // detail: tool call or notification
  t?: number; // turn start, unix seconds
  k?: number; // turn duration once done, seconds
  n?: number; // tasks completed
  of?: number; // tasks total
  task?: string; // task in progress
  c?: ContextWindow; // context window, when the busybar-context mod reports it
}

/** Context window usage, as the bridge compacts the busybar-context mod's breakdown. */
interface ContextWindow {
  pct: number; // percent of the window used
  lbl: string; // "412k/1M"
  max: number; // window size in tokens
  seg: [number, string][]; // used rows: [tokens, #RRGGBBAA]
  buf: number; // autocompact reserve, tokens
  leg: string; // "Messages 337k, Tools 41k, ..."
}

const LOOK: Record<Session["s"], { label: string; color: string }> = {
  input: { label: "APPROVE?", color: "#FF3B30FF" },
  tool: { label: "WORKING", color: "#FFCC00FF" },
  think: { label: "THINKING", color: ORANGE },
  compact: { label: "COMPACTING", color: "#BF5AF2FF" },
  done: { label: "DONE", color: "#34C759FF" },
  idle: { label: "WAITING", color: "#8E8E93FF" },
  ready: { label: "READY", color: "#64D2FFFF" },
};

type Element = Parameters<typeof device.DisplayDraw>[0]["elements"][number];

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

function text(id: string, value: string, x: number, y: number, width: number, font: "small" | "normal", color: string): Element {
  const el: Element = { id, type: "text", text: value || " ", x, y, align: "top_left", font, color };
  // Scroll only when the text does not fit: a static label is cheaper for the bar.
  if (textWidth(value, font) > width) {
    Object.assign(el, { width, scroll_rate: 1200, scroll_start_delay: 1500, scroll_repeat_delay: 2500 });
  }
  return el;
}

/** Claude, acting out a state. Re-sent only when the section changes, which restarts it. */
function sprite(section: Session["s"]): Element {
  return { id: "claude", type: "animation", path: claudeAnim, section, loop: true, x: 0, y: 0, align: "top_left" };
}

function rect(id: string, x: number, y: number, width: number, height: number, color: string): Element {
  return { id, type: "rectangle", x, y, width, height, fill: "solid", fill_colors: [color], border_width: 0 };
}

/** The frame for one session; `others` is how many more sessions are live. */
function frame(s: Session, others: number): Element[] {
  const look = LOOK[s.s] || LOOK.idle;
  const hasTasks = !!s.of;
  const els: Element[] = [sprite(LOOK[s.s] ? s.s : "idle")];

  // Row 1: what this is about, plus progress or elapsed time on the right.
  let right = "";
  if (hasTasks) right = `${s.n}/${s.of}`;
  const rightW = right ? textWidth(right, "small") + 5 : s.t ? 24 : 0;
  const title = hasTasks && s.task ? s.task : s.p + (others ? ` +${others}` : "");
  els.push(text("title", title, TEXT_X, TOP_Y, TEXT_W - rightW, "small", hasTasks && s.task ? "#FFFFFFFF" : DIM));
  if (right) {
    els.push({ id: "count", type: "text", text: right, x: W - 1, y: TOP_Y, align: "top_right", font: "small", color: DIM });
  } else if (s.t) {
    els.push({
      id: "elapsed", // its own id: the bar rejects changing an element's type
      type: "countdown",
      timestamp: String(s.t),
      direction: "time_since",
      show_hours: "when_non_zero",
      x: W - 1,
      y: TOP_Y,
      align: "top_right",
      color: DIM,
    });
  }

  // Row 2: what Claude is doing right now.
  let status = look.label;
  if (s.s === "tool" && s.d) status = s.d;
  else if (s.s === "done" && s.k != null) status = `DONE ${fmtDuration(s.k)}`;
  els.push(text("status", status, TEXT_X, hasTasks ? MID_Y - 1 : MID_Y, TEXT_W, "normal", look.color));

  // Row 3: task progress.
  if (hasTasks) {
    const of = s.of || 1;
    const filled = Math.round((TEXT_W * (s.n || 0)) / of);
    els.push(rect("track", TEXT_X, BAR_Y, TEXT_W, BAR_H, TRACK));
    if (filled > 0) els.push(rect("fill", TEXT_X, BAR_Y, filled, BAR_H, look.color));
  }
  return els;
}

/** The context window: a bar segmented by what fills it, like Claude Code's context bar. */
function contextFrame(s: Session): Element[] {
  const els: Element[] = [sprite(LOOK[s.s] ? s.s : "idle")];
  const c = s.c;
  els.push(text("ctitle", "CONTEXT", TEXT_X, TOP_Y, TEXT_W - 20, "small", DIM));
  if (!c) {
    els.push(text("cnone", "NO DATA", TEXT_X, MID_Y, TEXT_W, "normal", DIM));
    return els;
  }
  const pctColor = c.pct >= 80 ? LOOK.input.color : c.pct >= 60 ? LOOK.tool.color : "#FFFFFFFF";
  els.push({ id: "cpct", type: "text", text: `${c.pct}%`, x: W - 1, y: TOP_Y, align: "top_right", font: "small", color: pctColor });

  els.push(rect("ctrack", TEXT_X, CBAR_Y, TEXT_W, CBAR_H, TRACK));
  const width = (tokens: number) => Math.max(1, Math.round((TEXT_W * tokens) / c.max));
  let x = TEXT_X;
  c.seg.forEach(([tokens, color], i) => {
    const w = Math.min(width(tokens), W - x);
    if (w > 0) els.push(rect(`cs${i}`, x, CBAR_Y, w, CBAR_H, color));
    x += w;
  });
  // The autocompact reserve sits at the far end, as in /context.
  if (c.buf) {
    const w = Math.min(width(c.buf), W - x);
    if (w > 0) els.push(rect("cbuf", W - w, CBAR_Y, w, CBAR_H, "#FFFFFF60"));
  }
  els.push(text("cleg", `${c.lbl}: ${c.leg}`, TEXT_X, LEGEND_Y, TEXT_W, "small", DIM));
  return els;
}

/**
 * Removes everything this app drew. Uses the query parameter: a DELETE body sent from the
 * on-device fetch does not reach the API (busy-lib's DisplayClear gets a 400).
 */
async function clearLayer(): Promise<void> {
  try {
    await fetch(`http://${__BUSY_ADDR__}/api/display/draw?application_name=${APP}`, { method: "DELETE" });
  } catch {
    // Nothing drawn yet, or the layer is already gone.
  }
}

function messageFrame(title: string, status: string, color: string, section: Session["s"]): Element[] {
  return [
    sprite(section),
    text("title", title, TEXT_X, TOP_Y, TEXT_W, "small", DIM),
    text("status", status, TEXT_X, MID_Y, TEXT_W, "normal", color),
  ];
}

function main(): void {
  let bridge = DEFAULT_BRIDGE;
  let blinkLed = true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let drawing = false;

  let sessions: Session[] = [];
  let pick = 0; // which session the encoder selected; 0 = most urgent
  let view: "status" | "context" = "status"; // Start toggles
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  let shown: Record<string, string> = {}; // element id -> JSON currently on the bar
  let lastState = "";

  const report = (err: unknown) =>
    console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  /** Sends only the elements that changed; clears the layer first when one went away. */
  async function draw(elements: Element[], blink?: string): Promise<void> {
    if (drawing) return; // the next poll will catch up
    const next: Record<string, string> = {};
    for (const e of elements) next[e.id] = JSON.stringify(e);
    const removed = Object.keys(shown).some((id) => !(id in next));
    const changed = elements.filter((e) => removed || shown[e.id] !== next[e.id]);
    if (!changed.length) return;

    drawing = true;
    try {
      if (removed) {
        // Clearing by id fails if the bar already dropped one, so clear the whole layer.
        shown = {};
        await clearLayer();
      }
      await device.DisplayDraw({
        application_name: APP,
        priority: 50,
        elements: changed,
        ...(blink ? { led_notification_color: blink } : {}),
      });
      shown = next;
    } catch (err) {
      shown = {}; // unknown state on the bar: redraw everything next time
      throw err;
    } finally {
      drawing = false;
    }
  }

  function redraw(): Promise<void> {
    if (!sessions.length) {
      lastState = "";
      return draw(messageFrame("Claude Code", "NO SESSIONS", LOOK.idle.color, "idle"));
    }
    if (pick >= sessions.length) pick = 0;
    const s = sessions[pick];
    // Blink once when a session starts needing you or finishes, not on every redraw.
    const state = `${s.p}:${s.s}`;
    const blink =
      blinkLed && state !== lastState && (s.s === "input" || s.s === "done") ? LOOK[s.s].color : undefined;
    lastState = state;
    return draw(view === "context" ? contextFrame(s) : frame(s, sessions.length - 1), blink);
  }

  async function poll(): Promise<void> {
    try {
      const res = await fetch(`http://${bridge}/status`);
      if (!res.ok) throw new Error(`bridge ${res.status}`);
      const body = (await res.json()) as { sessions?: Session[] };
      sessions = body.sessions || [];
      failures = 0;
      await redraw();
    } catch (err) {
      failures += 1;
      if (failures === 1) report(err);
      if (failures >= 2) await draw(messageFrame(bridge, "NO BRIDGE", LOOK.input.color, "input")).catch(report);
    }
  }

  function schedule(): void {
    if (stopped) return;
    const delay = failures ? Math.min(POLL_MS * 2 ** Math.min(failures, 3), MAX_BACKOFF_MS) : POLL_MS;
    timer = setTimeout(() => {
      void poll()
        .catch(report)
        .then(schedule);
    }, delay);
  }

  async function start(): Promise<void> {
    const values = await loadValues();
    if (values) {
      if (typeof values.bridge === "string" && values.bridge.trim()) bridge = values.bridge.trim();
      if (typeof values.blink_led === "boolean") blinkLed = values.blink_led;
    }
    await draw(messageFrame("Claude Code", "CONNECTING", ORANGE, "think")).catch(report);
    await poll();
  }

  void start()
    .catch(report)
    .then(schedule);

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder" && sessions.length > 1) {
      // Rotate through sessions; the selection resets to "most urgent" with OK.
      pick = (pick + event.delta + sessions.length) % sessions.length;
      void redraw().catch(report);
      return;
    }
    if (event.key === "start" && event.action === "short") {
      // Context view on demand; it goes back to the status by itself.
      if (viewTimer) clearTimeout(viewTimer);
      viewTimer = undefined;
      view = view === "context" ? "status" : "context";
      if (view === "context") {
        viewTimer = setTimeout(() => {
          viewTimer = undefined;
          view = "status";
          void redraw().catch(report);
        }, CONTEXT_VIEW_MS);
      }
      void redraw().catch(report);
      return;
    }
    if (event.key === "ok" && event.action === "short") {
      pick = 0;
      void redraw().catch(report);
      return;
    }
    if (event.key !== "back" || event.action !== "short") return;

    stopped = true;
    if (timer) clearTimeout(timer);
    if (viewTimer) clearTimeout(viewTimer);
    void clearLayer();
    // Not unbound inside the handler itself: that would stop the app while it is still running.
    setTimeout(unbind, 0);
  });
}

main();
