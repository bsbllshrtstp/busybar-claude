#!/usr/bin/env node
// Installs (or with --uninstall, removes) the Claude Code -> BUSY Bar bridge:
//   1. Claude Code hooks in ~/.claude/settings.json that POST every event to the bridge.
//   2. A launchd agent that keeps bridge/server.mjs running.
//   3. The busybar-context mod (mod/busybar-context) in CLAUDE_CODE_PLUGIN_DIRS. It sends the
//      context window breakdown to the bridge for the bar's context view (Start button).
// It also strips the hooks of the old Python HTTP API integration (busybar_hook.py).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const uninstall = process.argv.includes("--uninstall");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BUSYBAR_BRIDGE_PORT || 7878);

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const LABEL = "com.busybar.claude-bridge";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = path.join(os.homedir(), "Library", "Logs", "busybar-bridge.log");
const MOD_DIR = path.resolve(HERE, "..", "mod", "busybar-context");

// Fire-and-forget: a stopped bridge must never slow Claude Code down.
const COMMAND = `curl -s -m 1 -o /dev/null --data-binary @- http://127.0.0.1:${PORT}/event || true`;
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "PreCompact",
  "Stop",
  "SubagentStop",
  "SessionEnd",
];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

const isOurs = (group) =>
  (group.hooks || []).some((h) => {
    const c = h.command || "";
    return c.includes("busybar_hook.py") || c.includes(`127.0.0.1:${PORT}/event`);
  });

function updateHooks() {
  const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, "utf8")) : {};
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak`);
  const hooks = (settings.hooks ??= {});

  for (const event of new Set([...EVENTS, ...Object.keys(hooks)])) {
    const groups = (hooks[event] || []).filter((g) => !isOurs(g));
    if (!uninstall && EVENTS.includes(event)) {
      const group = { hooks: [{ type: "command", command: COMMAND, timeout: 3 }] };
      groups.push(TOOL_EVENTS.has(event) ? { matcher: "*", ...group } : group);
    }
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;

  // Keep the other plugin folders listed there; replace any earlier busybar-context entry.
  const env = (settings.env ??= {});
  const dirs = String(env.CLAUDE_CODE_PLUGIN_DIRS || "")
    .split(":")
    .filter((d) => d && !d.replace(/\/+$/, "").endsWith("/busybar-context"));
  if (!uninstall) dirs.push(MOD_DIR);
  if (dirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(":");
  else delete env.CLAUDE_CODE_PLUGIN_DIRS;
  if (!Object.keys(env).length) delete settings.env;

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(
    `${uninstall ? "Removed" : "Installed"} hooks and the busybar-context mod in ${SETTINGS} (backup: settings.json.bak)`,
  );
}

function launchctl(...args) {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    // bootout of an agent that is not loaded fails; that is fine.
  }
}

function updateAgent() {
  const domain = `gui/${process.getuid()}`;
  launchctl("bootout", `${domain}/${LABEL}`);
  if (uninstall) {
    fs.rmSync(PLIST, { force: true });
    console.log("Removed the bridge launch agent");
    return;
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(HERE, "server.mjs")}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>BUSYBAR_BRIDGE_PORT</key><string>${PORT}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist);
  launchctl("bootstrap", domain, PLIST);
  console.log(`Bridge running on port ${PORT} via launchd (${PLIST}), log: ${LOG}`);
}

updateHooks();
updateAgent();
