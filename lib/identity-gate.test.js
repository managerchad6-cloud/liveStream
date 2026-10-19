// The livestream trust boundary: public (through Apache) vs operator (loopback).
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const express = require('express')
const request = require('supertest')
const { createIdentityClient } = require('vvc-identity-client')
const { createGate } = require('./identity-gate')

const ORIGIN = 'http://localhost:5291'
const keys = crypto.generateKeyPairSync('ed25519')
const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url')

function token(wallet, { member = true, ttl = 900 } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const h = enc({ alg: 'EdDSA', typ: 'JWT' })
  const p = enc({ iss: 'vvc-identity', aud: 'vvc', sub: wallet, sid: 's', mem: member, iat: now, exp: now + ttl })
  return `${h}.${p}.${crypto.sign(null, Buffer.from(`${h}.${p}`), keys.privateKey).toString('base64url')}`
}

/** A miniature livestream server wired the same way as the real ones. */
function makeApp() {
  const identity = createIdentityClient({
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), allowedOrigins: [ORIGIN],
  })
  const gate = createGate({
    identity,
    publicRoutes: [
      { method: 'GET', path: /^\/api\/suggestions$/ },
      { method: 'POST', path: /^\/api\/suggestions\/[^/]+\/vote$/ },
      { method: 'POST', path: /^\/api\/chat$/ },
    ],
  })
  const app = express()
  app.use(express.json())
  app.use(gate.middleware())
  app.get('/api/suggestions', (req, res) => res.json({ ok: true }))
  app.post('/api/suggestions/:id/vote', (req, res) => {
    const wallet = gate.member(req, res); if (!wallet) return
    res.json({ votedAs: wallet })
  })
  app.post('/api/chat', (req, res) => {
    const who = gate.participant(req, res); if (!who) return
    res.json(who)
  })
  app.post('/api/meme-intake/generate-all', (req, res) => res.json({ generated: true }))
  return app
}

// Through Apache = has X-Forwarded-For; the cookie and Origin are the browser's
const viaProxy = (req, wallet, opts = {}) => {
  req = req.set('X-Forwarded-For', '203.0.113.7').set('Origin', opts.origin ?? ORIGIN)
  return wallet ? req.set('Cookie', `vvc_at=${token(wallet, opts)}`) : req
}

describe('public requests (through Apache)', () => {
  test('only allowlisted routes are reachable; admin routes are not', async () => {
    const app = makeApp()
    assert.equal((await viaProxy(request(app).get('/api/suggestions'))).status, 200)
    const admin = await viaProxy(request(app).post('/api/meme-intake/generate-all'), 'Wmember')
    assert.equal(admin.status, 403)
    assert.equal(admin.body.code, 'operator_only')
  })

  test('participation needs a member and acts as the session wallet', async () => {
    const app = makeApp()
    const guest = await viaProxy(request(app).post('/api/suggestions/s1/vote').send({ wallet: 'Wvictim' }))
    assert.equal(guest.status, 401)
    const pending = await viaProxy(request(app).post('/api/suggestions/s1/vote'), 'Wpending', { member: false })
    assert.equal(pending.status, 403)
    assert.equal(pending.body.code, 'membership_required')
    const member = await viaProxy(request(app).post('/api/suggestions/s1/vote').send({ wallet: 'Wvictim' }), 'Wme')
    assert.equal(member.status, 200)
    assert.equal(member.body.votedAs, 'Wme')
  })

  test('chat from the public is a member, never the operator', async () => {
    const res = await viaProxy(request(makeApp()).post('/api/chat'), 'Wme')
    assert.deepEqual(res.body, { operator: false, wallet: 'Wme' })
  })

  test('cookie writes from other sites are refused', async () => {
    const res = await viaProxy(request(makeApp()).post('/api/suggestions/s1/vote'), 'Wme', { origin: 'https://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'bad_origin')
  })

  test('a forged X-Forwarded-For cannot be removed by the client, only added: still public', async () => {
    // A client can't make a proxied request look local: Apache always adds the header.
    const res = await viaProxy(request(makeApp()).post('/api/meme-intake/generate-all'))
    assert.equal(res.status, 403)
  })
})

describe('operator requests (loopback, not proxied)', () => {
  test('the director page and scripts keep full access', async () => {
    const app = makeApp()
    assert.equal((await request(app).post('/api/meme-intake/generate-all')).status, 200)
    const chat = await request(app).post('/api/chat').send({ message: 'hi' })
    assert.deepEqual(chat.body, { operator: true, wallet: null })
  })

  test('member-only actions still need a member, even locally', async () => {
    const res = await request(makeApp()).post('/api/suggestions/s1/vote').send({ wallet: 'Wvictim' })
    assert.equal(res.status, 401)
  })
})

describe('rate limiter', () => {
  test('counts per key within the window', () => {
    let now = 0
    const { rateLimiter } = require('./identity-gate')
    const allow = rateLimiter(2, 1000, () => now)
    assert.equal(allow('a'), true)
    assert.equal(allow('a'), true)
    assert.equal(allow('a'), false)
    assert.equal(allow('b'), true)
    now = 1000
    assert.equal(allow('a'), true)
  })
})

describe('holder gate', () => {
  // Stands in for the identity client: X-Test-Identity is "wallet,member,holder" ("-" = unset)
  function fakeIdentity({ withRequireHolder }) {
    const fail = (res, status, code) => res.status(status).json({ code })
    const id = {
      middleware: () => (req, res, next) => {
        const h = req.headers['x-test-identity']
        if (!h) { req.identity = null; return next() }
        const [wallet, member, holder] = h.split(',')
        req.identity = { wallet, member: member === '1' }
        if (holder !== '-') req.identity.holder = holder === '1'
        next()
      },
      requireMember(req, res) {
        if (!req.identity) { fail(res, 401, 'auth_required'); return null }
        if (!req.identity.member) { fail(res, 403, 'membership_required'); return null }
        return req.identity.wallet
      },
    }
    if (withRequireHolder) {
      id.requireHolder = (req, res) => {
        if (req.identity.holder !== true) { fail(res, 403, 'hold_required'); return null }
        return req.identity.wallet
      }
    }
    return id
  }

  function holderApp(identity) {
    const gate = createGate({ identity, publicRoutes: [{ method: 'POST', path: /^\/api\/chat$/ }] })
    const app = express()
    app.use(gate.middleware())
    app.post('/api/chat', (req, res) => {
      const who = gate.participant(req, res); if (!who) return
      if (!who.operator && !gate.holder(req, res)) return
      res.json(who)
    })
    return app
  }
  const as = (req, ident) => req.set('X-Forwarded-For', '203.0.113.7').set('X-Test-Identity', ident)

  test('uses the client requireHolder when it has one', async () => {
    const app = holderApp(fakeIdentity({ withRequireHolder: true }))
    assert.equal((await as(request(app).post('/api/chat'), 'Wh,1,1')).status, 200)
    const sold = await as(request(app).post('/api/chat'), 'Ws,1,0')
    assert.equal(sold.status, 403)
    assert.equal(sold.body.code, 'hold_required')
    // A client with requireHolder refuses a token that has no hold claim at all
    assert.equal((await as(request(app).post('/api/chat'), 'Wo,1,-')).status, 403)
  })

  test('older clients: refuses only when req.identity.holder is false', async () => {
    const app = holderApp(fakeIdentity({ withRequireHolder: false }))
    assert.equal((await as(request(app).post('/api/chat'), 'Wh,1,1')).status, 200)
    const sold = await as(request(app).post('/api/chat'), 'Ws,1,0')
    assert.equal(sold.status, 403)
    assert.equal(sold.body.code, 'hold_required')
    assert.equal((await as(request(app).post('/api/chat'), 'Wo,1,-')).status, 200)
  })

  test('still needs a member first', async () => {
    const app = holderApp(fakeIdentity({ withRequireHolder: true }))
    const res = await as(request(app).post('/api/chat'), 'Wp,0,1')
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'membership_required')
  })

  test('the operator is not asked to hold', async () => {
    const res = await request(holderApp(fakeIdentity({ withRequireHolder: true }))).post('/api/chat')
    assert.deepEqual(res.body, { operator: true, wallet: null })
  })
})

describe('chat daily cap', () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { dailyCap } = require('./identity-gate')
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-daily-')), 'data', 'chat-daily.json')
  const DAY = 86_400_000

  test('allows the limit per wallet per day, then refuses', () => {
    let now = Date.UTC(2026, 9, 19, 10)
    const cap = dailyCap(3, tmpFile(), () => now)
    assert.deepEqual([cap.take('a'), cap.take('a'), cap.take('a'), cap.take('a')], [true, true, true, false])
    assert.equal(cap.take('b'), true)
    now += DAY
    assert.equal(cap.take('a'), true)
    assert.equal(cap.used('a'), 1)
  })

  test('a restart does not reset the count', () => {
    const file = tmpFile()
    const now = () => Date.UTC(2026, 9, 19, 10)
    const first = dailyCap(2, file, now)
    first.take('a'); first.take('a')
    const afterRestart = dailyCap(2, file, now)
    assert.equal(afterRestart.take('a'), false)
    assert.equal(afterRestart.take('b'), true)
  })

  test('yesterday\'s saved counts do not carry over', () => {
    const file = tmpFile()
    let now = Date.UTC(2026, 9, 19, 23)
    const a = dailyCap(1, file, () => now)
    a.take('a')
    now = Date.UTC(2026, 9, 20, 1)
    assert.equal(dailyCap(1, file, () => now).take('a'), true)
  })
})

describe('one message at a time', () => {
  test('a wallet waits for its last message; others do not', () => {
    const { oneAtATime } = require('./identity-gate')
    const claim = oneAtATime()
    const release = claim('a')
    assert.ok(release)
    assert.equal(claim('a'), null)
    assert.ok(claim('b'))
    release(); release() // releasing twice is harmless
    assert.ok(claim('a'))
  })
})
