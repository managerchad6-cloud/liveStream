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
const fs = require('fs')
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
 * Per-key allowance per UTC day, saved to `file` so a restart doesn't hand out a fresh one.
 * take(key) uses one and returns true, or returns false once the key has used `limit` today.
 */
function dailyCap(limit, file, now = Date.now) {
  const today = () => new Date(now()).toISOString().slice(0, 10)
  let state = { day: today(), counts: {} }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved?.day && saved.counts && typeof saved.counts === 'object') state = saved
  } catch { /* first run or unreadable: start empty */ }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state))
      fs.renameSync(`${file}.tmp`, file)
    } catch (err) { console.warn('[dailyCap] save failed:', err.message) }
  }
  return {
    take(key) {
      const day = today()
      if (state.day !== day) state = { day, counts: {} }
      const used = state.counts[key] || 0
      if (used >= limit) return false
      state.counts[key] = used + 1
      save()
      return true
    },
    used: key => (state.day === today() ? state.counts[key] || 0 : 0),
  }
}

/** One job at a time per key: claim(key) → release function, or null while one is still running. */
function oneAtATime() {
  const busy = new Set()
  return key => {
    if (busy.has(key)) return null
    busy.add(key)
    let done = false
    return () => { if (!done) { done = true; busy.delete(key) } }
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

  /**
   * Members who still hold $VVC: returns their wallet, or null after answering 401/403
   * (403 hold_required when they don't hold). Uses the identity client's requireHolder; older
   * clients without it only expose req.identity.holder, and only an explicit false is refused.
   */
  function holder(req, res) {
    const wallet = identity.requireMember(req, res)
    if (!wallet) return null
    if (typeof identity.requireHolder === 'function') return identity.requireHolder(req, res)
    if (req.identity?.holder === false) {
      fail(res, 403, 'hold_required', 'Hold $VVC to chat')
      return null
    }
    return wallet
  }

  return { middleware, member, participant, holder, rateLimiter, dailyCap, oneAtATime, fail }
}

module.exports = { createGate, isPublic, rateLimiter, dailyCap, oneAtATime }
