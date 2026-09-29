/**
 * Economy-mode routes, served under the plugin's own prefix.
 *
 * They live beside the holiday route rather than under `/api`, which belongs
 * to the API gateway. Every request is put through
 * `connection.requestRejection()` — resolved per request, because Connection
 * may activate after the route is installed — so the endpoints inherit the
 * harness's own Host/Origin fence and browser-session check instead of
 * inventing an unauthenticated surface.
 *
 * @module dsh-peak-status/economy/routes
 */

/** Sibling of {@link ROUTE_PREFIX}; `/api` is reserved by the API gateway. */
export const ECONOMY_PREFIX = '/dsh-peak-status/economy'

const MAX_BODY_BYTES = 16 * 1024

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

const sendText = (res, status, text) => {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })

const parseBody = async (req) => {
  try {
    const raw = await readBody(req)
    if (raw.length === 0) return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/**
 * Build the request handler.
 *
 * @param options.ctx - host context (`connection` for the fence).
 * @param options.report - structured log sink.
 * @param options.status - `(sessionId) => status payload`.
 * @param options.toggle - `(sessionId) => boolean|null`.
 * @param options.set - `(sessionId, enabled) => boolean|null`.
 * @returns an async `(req, res)` handler.
 */
export const createEconomyHandler = ({ ctx, report = () => {}, status, toggle, set }) => async (req, res) => {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
  }

  const url = new URL(req.url === undefined ? '/' : req.url, 'http://localhost')
  const endpoint = url.pathname.slice(ECONOMY_PREFIX.length).replace(/^\/+/, '')
  const queryId = url.searchParams.get('sessionId')

  try {
    if (endpoint === 'status' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, status(queryId))
      return
    }
    if (endpoint === 'toggle' && req.method === 'POST') {
      const body = await parseBody(req)
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'body is not JSON' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : queryId
      const next = toggle(sessionId)
      if (next === null) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      sendJson(res, 200, status(sessionId))
      return
    }
    if (endpoint === 'set' && req.method === 'POST') {
      const body = await parseBody(req)
      if (body === null || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'enabled (boolean) is required' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : queryId
      const next = set(sessionId, body.enabled)
      if (next === null) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      sendJson(res, 200, status(sessionId))
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    report('economy route failed', { endpoint, message: String((error && error.message) || error) })
    sendJson(res, 500, { ok: false, error: 'internal' })
  }
}
