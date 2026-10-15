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
