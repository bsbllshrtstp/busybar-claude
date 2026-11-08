import type { EngineInterface, Register } from 'claude-code'

/** The BUSY Bar bridge (bridge/server.mjs in the busybar-claude repository). */
const BRIDGE = 'http://127.0.0.1:7878/context'

/**
 * `session.measure` fires once per turn; this keeps a long turn's bar current and
 * refills a bridge that restarted.
 */
const REFRESH_MS = 30_000

/**
 * Posts the context window breakdown to the bridge. `summary` estimates
 * locally from the last response's usage, so it costs no API call.
 * The bar is a nice-to-have: a stopped bridge is ignored.
 */
async function push($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const breakdown = usage.context.breakdown
  if (!breakdown) return

  const categories = breakdown.categories
    // Deferred tool schemas sit outside the window; /context's grid skips them too.
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))

  const body = JSON.stringify({
    session_id: await $.session.id(),
    total: breakdown.totalTokens,
    max: breakdown.rawMaxTokens,
    percentage: breakdown.percentage,
    categories,
  })
  try {
    await $.http.fetch(BRIDGE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  } catch {
    // Bridge not running.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await push($)
    $.clock.every(REFRESH_MS, () => void push($).catch(() => undefined))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await push($)
    return result
  })
}
