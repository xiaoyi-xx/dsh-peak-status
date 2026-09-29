/**
 * The request gate — one chat's economy mode, enforced at the model boundary.
 *
 * `llm/stream` is the waterfall every model call passes through, and
 * `GenerateOptions` carries the `sessionId` stamped by the agent loop. That is
 * what makes the hold per-chat: the decision is
 * "this chat has economy mode on" AND "the schedule says peak".
 *
 * Holding is implemented by returning a wrapper stream: iteration first waits
 * for the gate to open and only then calls `next()`, so nothing is sent and
 * nothing is billed. `options` passes through untouched, leaving routing,
 * retry and validation to the rest of the chain.
 *
 * The wait always ends: at the window's resume instant, when the request is
 * aborted, when the chat's switch is turned off, when the schedule changes, on
 * a periodic re-check, or when the plugin unloads (fail-open).
 *
 * @module dsh-peak-status/economy/gate
 */

/** DeepSeek's own route is the only one with peak pricing. */
const DEEPSEEK_ROUTE = 'deepseek-official'

const matchesRoute = (options, filter) => {
  if (filter !== DEEPSEEK_ROUTE) return true
  const provider = String(options?.provider ?? '').toLowerCase()
  return provider === DEEPSEEK_ROUTE || provider.startsWith('deepseek-')
}

/** Last-resort bound when a window yields no resume instant. */
const NO_DEADLINE_FALLBACK_MS = 12 * 60 * 60 * 1000

/** How long one hold may last given the state that justified it. */
export const holdDeadline = (state, now) => {
  const known = state.resumeAt !== null && state.resumeAt !== undefined
  if (!known) return { delay: NO_DEADLINE_FALLBACK_MS, reason: 'no-deadline' }
  return { delay: Math.max(1, state.resumeAt - now), reason: 'window-ended' }
}

/**
 * Create the gate.
 *
 * @param options.ctx - host plugin context.
 * @param options.getConfig - returns the live, normalized config.
 * @param options.getState - `(now) => state` from the schedule (holiday-aware).
 * @param options.isEnabled - `(sessionId) => boolean`, the per-chat switch.
 * @param options.report - structured log sink.
 * @returns the gate handle.
 */
export const createGate = ({ ctx, getConfig, getState, isEnabled, report = () => {} }) => {
  /** Live waits, so the host can release every held call at once. */
  const waiters = new Set()
  let disposed = false

  /**
   * Decide one request.
   * @param options - the `llm/stream` request.
   * @param now - reference instant.
   * @returns `{ hold: false, reason }` or `{ hold: true, state, sessionId }`.
   */
  const decide = (options, now) => {
    const config = getConfig()
    if (config.enabled !== true) return { hold: false, reason: 'disabled' }

    const sessionId = options?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      // Hand-built one-shots carry no session; they cannot be attributed to a
      // chat, so they are never held.
      return { hold: false, reason: 'no-session' }
    }
    if (!isEnabled(sessionId)) return { hold: false, reason: 'session-off' }
    if (!matchesRoute(options, config.routeFilter)) return { hold: false, reason: 'route-exempt' }

    const state = getState(now)
    if (state.state !== 'PAUSED') return { hold: false, reason: state.reason }
    return { hold: true, state, sessionId }
  }

  /** Release every waiter whose hold no longer stands. */
  const revalidate = () => {
    const now = Date.now()
    for (const waiter of [...waiters]) {
      const decision = decide(waiter.options, now)
      if (!decision.hold) waiter.finish(decision.reason)
    }
  }

  /** Release every waiter unconditionally (unload, emergency end). */
  const releaseAll = (reason = 'released') => {
    for (const waiter of [...waiters]) waiter.finish(reason)
  }

  const waitForRelease = (options, state) =>
    new Promise((resolve) => {
      let settled = false
      let timer = null
      const signal = options?.signal
      // The waiter exists before any release path can reach it.
      const waiter = { options, finish: undefined, sessionId: options?.sessionId ?? null }

      const finish = (reason) => {
        if (settled) return
        settled = true
        try {
          if (timer !== null) clearTimeout(timer)
        } catch {
          // a timer that never armed has nothing to clear
        }
        try {
          if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort)
        } catch {
          // an exotic signal without listener support
        }
        waiters.delete(waiter)
        resolve(reason)
      }
      waiter.finish = finish

      const onAbort = () => finish('aborted')

      try {
        const { delay, reason } = holdDeadline(state, Date.now())
        timer = setTimeout(() => finish(reason), delay)
      } catch {
        // Timers have failed here in some fiber contexts; the periodic
        // re-check and the abort path still release the request.
        timer = null
      }

      waiters.add(waiter)
      if (signal) {
        if (signal.aborted) finish('aborted')
        else if (signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
      }
    })

  return {
    decide,
    revalidate,
    releaseAll,
    /**
     * Install the `llm/stream` listener.
     * @returns the disposer.
     */
    install() {
      const dispose = ctx.on('llm/stream', (options, next) => {
        let decision
        try {
          decision = decide(options, Date.now())
        } catch (error) {
          report('gate decision failed; request passed through', {
            message: String((error && error.message) || error),
          })
          return next()
        }
        if (!decision.hold) return next()

        report('holding request', {
          sessionId: decision.sessionId,
          provider: options?.provider ?? null,
          model: options?.model ?? null,
          purpose: options?.purpose ?? null,
          until: decision.state.resumeAt ?? null,
        })

        return (async function* held() {
          const reason = await waitForRelease(options, decision.state)
          report('released request', { sessionId: decision.sessionId, reason })
          yield* next()
        })()
      })
      return () => {
        disposed = true
        releaseAll('unload')
        dispose()
      }
    },
    /** Chats whose model calls are parked right now. */
    get pending() {
      const ids = new Set()
      for (const waiter of waiters) if (waiter.sessionId) ids.add(waiter.sessionId)
      return [...ids]
    },
    /** Number of parked calls. */
    get pendingCount() {
      return waiters.size
    },
    get disposed() {
      return disposed
    },
  }
}
