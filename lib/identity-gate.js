// Who may do what on the livestream servers (chat :3002, animation :3003).
//
// The trust boundary is the reverse proxy:
//   - Requests that came through Apache (X-Forwarded-For set, or not from loopback) are the public.
//     Only the routes listed as public are reachable, and participation needs a VVC member
//     (identity session, verified offline by vvc-identity-client).
//   - Requests made directly on the server's loopback are the operator (director page, scripts,
//     the other livestream server). They keep working exactly as before.
//
// So admin routes (/api/meme-intake/generate-all, /api/lists/refresh, /api/orchestrator/play, …)
// can never be reached from the internet, whatever paths Apache happens to forward.
const path = require('path')
const { createIdentityClient } = require('vvc-identity-client')

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when the request came through the public reverse proxy (or from anywhere not local). */
function isPublic(req) {
  return Boolean(req.headers['x-forwarded-for']) || !LOOPBACK.has(req.socket?.remoteAddress)
}

/** Fixed-window per-key limiter (in memory; each server is one process). */
function rateLimiter(limit, windowMs, now = Date.now) {
  const hits = new Map()
  return key => {
    const t = now()
    const h = hits.get(key)
    if (!h || t - h.start >= windowMs) {
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k)
      hits.set(key, { start: t, count: 1 })
      return true
    }
    return ++h.count <= limit
  }
}

/**
 * @param {object} opts
 * @param {{method: string, path: RegExp}[]} opts.publicRoutes Routes the public may reach (everything else: operator only)
 * @param {ReturnType<typeof createIdentityClient>} [opts.identity] defaults to one built from env
 */
function createGate({ publicRoutes, identity }) {
  identity ??= createIdentityClient({
    publicKeyPath: process.env.IDENTITY_PUBLIC_KEY_PATH
      || path.join(__dirname, '..', '..', 'identity', '.dev-keys', 'identity_ed25519.pub.pem'),
    allowedOrigins: (process.env.IDENTITY_ALLOWED_ORIGINS || 'https://suite.virginvschad.vip')
      .split(',').map(s => s.trim()).filter(Boolean),
  })
  const verify = identity.middleware()
  const fail = (res, status, code, message) => res.status(status).json({ code, message, error: message })

  /** Route allowlist for the public + session verification. Mount before the routes. */
  function middleware() {
    return (req, res, next) => {
      req.operator = !isPublic(req)
      if (!req.operator) {
        const allowed = publicRoutes.some(r => r.method === req.method && r.path.test(req.path))
        if (!allowed) return fail(res, 403, 'operator_only', 'Not available')
      }
      verify(req, res, next)
    }
  }

  /** Public callers must be members: returns their wallet, or null after answering 401/403. */
  function member(req, res) {
    return identity.requireMember(req, res)
  }

  /**
   * Who is acting: {operator: true} for the operator, {wallet} for a member; null after answering.
   * For routes the operator also uses (chat, director votes, meme submissions).
   */
  function participant(req, res) {
    if (req.operator) return { operator: true, wallet: null }
    const wallet = identity.requireMember(req, res)
    return wallet ? { operator: false, wallet } : null
  }

  return { middleware, member, participant, rateLimiter, fail }
}

module.exports = { createGate, isPublic, rateLimiter }
