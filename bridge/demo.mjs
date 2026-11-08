#!/usr/bin/env node
// Feeds the bridge a scripted Claude Code session so you can see every state on the bar.
//   node demo.mjs            # step every 4 s
//   node demo.mjs 8          # step every 8 s
//   node demo.mjs --step N   # apply steps 0..N instantly and stay there (for screenshots)

const PORT = Number(process.env.BUSYBAR_BRIDGE_PORT || 7878);
const SID = "busybar-demo";
const cwd = "/Users/demo/dev/my-project";

const todos = (doneCount, total = 5) =>
  ["Read the codebase", "Write the parser", "Add tests", "Fix lint errors", "Update docs"]
    .slice(0, total)
    .map((content, i) => ({
      content,
      activeForm: content.replace(/^(\w+)/, (w) => `${w.replace(/e$/, "")}ing`),
      status: i < doneCount ? "completed" : i === doneCount ? "in_progress" : "pending",
    }));

const STEPS = [
  ["ready", { hook_event_name: "SessionStart" }],
  ["thinking", { hook_event_name: "UserPromptSubmit" }],
  ["tool", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test -- --watch=false" } }],
  ["tasks 1/5", { hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_input: { todos: todos(1) } }],
  ["tasks 1/5 + tool", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/x/src/parser.ts" } }],
  ["needs approval", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }],
  ["tasks 3/5", { hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_input: { todos: todos(3) } }],
  ["thinking 3/5", { hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos: todos(3) } }],
  ["compacting", { hook_event_name: "PreCompact" }],
  ["tasks 5/5", { hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_input: { todos: todos(5) } }],
  ["done", { hook_event_name: "Stop" }],
  ["idle", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }],
  ["end", { hook_event_name: "SessionEnd" }],
];

const post = (ev) =>
  fetch(`http://127.0.0.1:${PORT}/event`, {
    method: "POST",
    body: JSON.stringify({ session_id: SID, cwd, ...ev }),
  });

const args = process.argv.slice(2);
const stepAt = args.indexOf("--step");
if (stepAt >= 0) {
  const n = Number(args[stepAt + 1]);
  await post({ hook_event_name: "SessionEnd" });
  for (const [, ev] of STEPS.slice(0, n + 1)) await post(ev);
  console.log(`at step ${n}: ${STEPS[n][0]}`);
} else {
  const delay = Number(args[0] || 4) * 1000;
  for (const [label, ev] of STEPS) {
    await post(ev);
    console.log(label);
    await new Promise((r) => setTimeout(r, delay));
  }
}
