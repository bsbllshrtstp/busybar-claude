import type { EngineInterface, Register } from 'claude-code'

/** The BUSY Bar bridge (bridge/server.mjs in the busybar-claude repository). */
const BRIDGE = 'http://127.0.0.1:7878'

/**
 * `session.measure` fires once per turn; this keeps a long turn's bar current and
 * refills a bridge that restarted.
 */
const REFRESH_MS = 30_000

const TOOL = 'tasks'
const TOOL_ID = `mcp__busybar-context__${TOOL}`
/** Matches the tool by pattern: its name joins the typed tool list only once it is registered. */
const TOOL_MATCH = /^mcp__busybar-context__tasks$/

const TASK_LIST_PROMPT = `# Task list on the BUSY Bar
The user follows your progress on a BUSY Bar display, through the \`${TOOL_ID}\` tool.
- For every request that takes more than one step (anything beyond a direct answer or a single quick action), call \`${TOOL_ID}\` before you start, with the whole plan as tasks.
- Call it again with the complete, updated list whenever a task starts (\`in_progress\`, one at a time) or finishes (\`completed\`), as soon as that happens rather than in batches. Add tasks you discover along the way.
- Before you end your turn, mark finished tasks \`completed\` and remove ones you dropped.
- Keep titles short (the display is 72 pixels wide) and give each task an \`active\` form in the present continuous, e.g. "Running tests".`

async function post($: EngineInterface, path: string, payload: object): Promise<boolean> {
  try {
    const res = await $.http.fetch(`${BRIDGE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: await $.session.id(), ...payload }),
    })
    return res.ok
  } catch {
    return false // Bridge not running: the bar is a nice-to-have.
  }
}

/**
 * Posts the context window breakdown to the bridge. `summary` estimates
 * locally from the last response's usage, so it costs no API call.
 */
async function pushContext($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const breakdown = usage.context.breakdown
  if (!breakdown) return

  const categories = breakdown.categories
    // Deferred tool schemas sit outside the window; /context's grid skips them too.
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))

  await post($, '/context', {
    total: breakdown.totalTokens,
    max: breakdown.rawMaxTokens,
    percentage: breakdown.percentage,
    categories,
  })
}

type Task = { title: string; status: 'pending' | 'in_progress' | 'completed'; active?: string }

export const register: Register = (on, options) => {
  const taskList = options.task_list !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (taskList) {
      await $.tool.register({
        name: TOOL,
        description:
          "Shows your task list on the user's BUSY Bar. Call it with the complete list every time it changes: " +
          'when you plan, when a task starts and when one finishes. Exactly one task is in_progress while you work.',
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'The whole task list, in order',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Short imperative title, e.g. "Run tests"' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                  active: { type: 'string', description: 'Present continuous form, e.g. "Running tests"' },
                },
                required: ['title', 'status'],
              },
            },
          },
          required: ['tasks'],
        },
        // In the prompt's tool list from the start, not behind ToolSearch.
        isDeferred: false,
      })
    }
    await pushContext($)
    $.clock.every(REFRESH_MS, () => void pushContext($).catch(() => undefined))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await pushContext($)
    return result
  })

  if (!taskList) return

  // The tool only reports progress: no permission prompt for it.
  on('tool.check', { tool: TOOL_MATCH }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: TOOL_MATCH }, async ($, e) => {
    const input = e as { tasks?: unknown }
    const tasks: Task[] = Array.isArray(input.tasks) ? input.tasks : []
    const sent = await post($, '/tasks', { tasks })
    const done = tasks.filter(t => t.status === 'completed').length
    return {
      result: `Task list updated: ${done}/${tasks.length} done${sent ? '' : ' (BUSY Bar bridge not reachable; carry on)'}.`,
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL_ID)) return composed
    return {
      sections: [...composed.sections, { id: 'busybar-context:task-list', text: TASK_LIST_PROMPT, scope: 'session' as const }],
    }
  })
}
