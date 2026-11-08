# Claude Code on the BUSY Bar

A BUSY Bar JavaScript app that shows what Claude Code is doing: an animated pixel Claude
acting out the current state, the tool it is running, the task it is on, and how far through
its task list it is.

```
[Claude]  Writing the parser    1/5     ← current task · tasks done / total
[16×16 ]  Edit parser.ts                ← state or tool call, colour-coded, scrolls if long
[ anim ]  ▬▬▬▬▬▬░░░░░░░░░░░░░░░         ← task progress
```

With no task list, the top row shows the project and how long the turn has been running.

| State | When | Colour | Claude |
|---|---|---|---|
| READY | session started | cyan | stands, blinks |
| THINKING | prompt submitted, tool finished | Claude orange | looks around, thought dots `. .. ...` |
| `<Tool> <detail>` | tool running (`Bash npm test`, `Edit app.tsx`) | yellow | marches in place, arms pumping |
| APPROVE? | permission prompt (LED blinks) | red | jumps and waves, red `!` |
| COMPACTING | context compaction | purple | squashes down and springs back |
| DONE 2m14s | turn finished (LED blinks) | green | hops with a happy face |
| WAITING | idle, waiting for your next prompt | gray | asleep, z's drifting up |

Progress comes from Claude's task list. Most sessions don't offer Claude a task-list tool,
so the `busybar-context` mod adds one, `mcp__busybar-context__tasks`. It runs without a
permission prompt, and a system prompt section asks Claude to plan every multi-step request
with it and keep it current. Turn that off with the mod's **Always keep a task list** option
in `/config`. The built-in `TodoWrite` and `TaskCreate`/`TaskUpdate` lists show up on the bar
too, when a session uses them.

Press **Start** to see the context window instead. It shows a bar split by what fills the
window (system prompt, tools, MCP, memory, messages), with the autocompact reserve at the far
end, the percent used, and a scrolling legend such as `412k/1M: Messages 337k, Tools 41k, ...`.
Press Start again, or wait 30 s, to go back to the status. The numbers come from the
`busybar-context` mod, which reads the same breakdown as `/context` (estimated locally, with
no API call) whenever the context changes.

## How it works

```
Claude Code hooks ──curl POST /event──▶ bridge/server.mjs (Mac :7878) ◀──GET /status every 2 s── app on the bar
busybar-context mod ──POST /context, /tasks──▶
```

- **`app/`** is the BUSY Bar app (`app.thaight.claude`), built with
  [busy-tools](https://github.com/busy-app/busy-tools). It runs on the bar. Over the device
  API it only uses `display/draw` and `apps/settings`.
- **`mod/busybar-context/`** is a Claude Code mod. It posts the context window breakdown to
  the bridge, and gives Claude the task-list tool the bar's progress comes from.
- **`bridge/`** is a dependency-free Node server on the Mac. Claude Code hooks post every
  event to it on loopback, and it keeps per-session state in memory. The bar polls
  `GET /status`, which accepts only loopback and private-network clients.

When several sessions are open, the bar shows the most urgent one: APPROVE? first, then
working, then done. Turn the encoder to step through sessions and press OK to go back to the
most urgent one. Start toggles the context view. A short press of Back quits the app.

## Setup

Requires Node 24 for the app tooling. Node 26 is not supported by busy-tools. The bridge
runs on any recent Node.

1. **Bridge, hooks and mod.** `node bridge/install.mjs` adds the hooks to `~/.claude/settings.json`
   (backup in `settings.json.bak`) and starts the bridge as a launchd agent
   (`com.busybar.claude-bridge`, log in `~/Library/Logs/busybar-bridge.log`). It also
   adds `mod/busybar-context` to `CLAUDE_CODE_PLUGIN_DIRS` (other folders listed there are
   kept), so the mod loads in new sessions, and removes the hooks of the old Python HTTP API
   integration (`busybar_hook.py`). `node bridge/install.mjs --uninstall` removes all three.
   Instead of the installer's `CLAUDE_CODE_PLUGIN_DIRS` entry, the mod can also be installed
   as a plugin. Use one or the other, not both, or every snapshot is sent twice. At the
   prompt of a terminal session:
   ```
   /plugin install busybar-context --marketplace bsbllshrtstp/busybar-claude
   ```
   Answer `y` to add the marketplace, then pick a scope. From a shell:
   `claude plugin install busybar-context --marketplace bsbllshrtstp/busybar-claude`.
   In the desktop app, where `/plugin` does not run: click + next to the prompt box, then
   Plugins, Add marketplace with `bsbllshrtstp/busybar-claude`, then Add plugin.
2. **App.**
   ```sh
   cd app
   npm install
   npm run build && npm run app:install && npm run app:run
   ```
   Then open **Claude Code** from the bar's APPS menu.

### Connection

By default the app polls `10.0.4.21:7878`, which is the Mac's address on the USB link (the
bar is `10.0.4.20`). To use the bar over Wi-Fi only, set the app's **Bridge address**
setting to `<mac-lan-ip>:7878` in the bar's web UI. Port 7878 can be changed with
`BUSYBAR_BRIDGE_PORT`. If you change it, reinstall and update the setting.

## Development

- The character lives in `app/tools/make-claude-anim.mjs`. It draws every frame in code and
  encodes `app/src/animations/claude.anim` in the bar's `.anim` format, with one named section
  per state. After editing it, run `npm run anim` (add `-- --preview /tmp/claude.png` for a
  zoomed sprite sheet), then build and install as usual.
- `node bridge/demo.mjs` plays a scripted session through every state, one step every 4 s.
  `node bridge/demo.mjs --step 5` jumps to one step and stays there.
- `curl localhost:7878/status` shows what the bar sees. `curl localhost:7878/debug` shows
  the full session state and the last 40 raw hook payloads.
- Device quirks found while building this:
  - A partial `DELETE /api/display/draw` with `element_ids` fails if any id is already gone.
  - A DELETE body sent from the on-device `fetch` does not reach the API, so the app clears
    its layer with the `application_name` query parameter.
  - Re-drawing an element id with a different `type` is rejected.
