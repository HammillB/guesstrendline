// Tests the create-class Worker with mocked Google, Turnstile and Firestore. Run: node tests/worker.test.mjs
import { webcrypto, generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
const { subtle } = webcrypto;

// Firebase-style signing key (served as JWKS) and a service-account key (PEM).
const fb = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await subtle.exportKey('jwk', fb.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ client_email: 'x@trendlinegame.iam.gserviceaccount.com', private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }) });

async function idToken(over = {}, kid = 'k1', key = fb.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const p = { aud: 'trendlinegame', iss: 'https://securetoken.google.com/trendlinegame', sub: 'teacher1', iat: now - 5, exp: now + 3600, ...over };
  const u = b64u(JSON.stringify({ alg: 'RS256', kid })) + '.' + b64u(JSON.stringify(p));
  return u + '.' + b64u(await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(u)));
}

let turnstile, commits, commitStatuses;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.includes('securetoken@system')) return j({ keys: [jwk] });
  if (url.includes('oauth2.googleapis.com')) return j({ access_token: 'AT', expires_in: 3600 });
  if (url.includes('turnstile')) return j(turnstile);
  if (url.includes('documents:commit')) {
    const body = JSON.parse(init.body);
    commits.push(body);
    const st = commitStatuses.shift() ?? 200;
    return st === 200 ? j({}) : j({ error: { status: st === 409 ? 'ALREADY_EXISTS' : 'INTERNAL' } }, st);
  }
  throw new Error('unexpected fetch ' + url);
};

const ENV = { TURNSTILE_SECRET: 's', FIREBASE_SERVICE_ACCOUNT: SA };
async function call(body, { env = ENV, origin = 'https://fittheline.com', method = 'POST', path = '/api/create-class' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request('https://fittheline.com' + path, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }), env);
}
async function good(over = {}) {
  return { level: 'easy', rounds: 5, autoNames: true, turnstileToken: 't', idToken: await idToken(), ...over };
}
function reset() { turnstile = { success: true, hostname: 'fittheline.com' }; commits = []; commitStatuses = []; }
let n = 0;
async function t(name, fn) { reset(); await fn(); n++; console.log('ok -', name); }

await t('valid request creates class + roster owned by the token uid', async () => {
  const r = await call(await good());
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.match(out.code, /^[A-HJ-NP-Z]{4}$/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://fittheline.com');
  const w = commits[0].writes;
  assert.equal(w[0].update.fields.hostUid.stringValue, 'teacher1');
  assert.deepEqual(w[0].currentDocument, { exists: false });
  assert.equal(w[0].update.fields.rounds.integerValue, '5');
  assert.ok(w[0].update.name.endsWith('/classes/' + out.code));
  assert.ok(w[1].update.name.endsWith('/classes/' + out.code + '/meta/roster'));
  assert.equal(w[1].update.fields.count.integerValue, '0');
});
await t('retries on code collision', async () => {
  commitStatuses = [409, 409, 200];
  const r = await call(await good());
  assert.equal(r.status, 200); assert.equal(commits.length, 3);
});
await t('gives up after 6 collisions', async () => {
  commitStatuses = [409, 409, 409, 409, 409, 409];
  assert.equal((await call(await good())).status, 503);
});
await t('Firestore error -> 502', async () => {
  commitStatuses = [500];
  assert.equal((await call(await good())).status, 502);
});
await t('failed Turnstile -> 403, nothing written', async () => {
  turnstile = { success: false };
  assert.equal((await call(await good())).status, 403); assert.equal(commits.length, 0);
});
await t('Turnstile from wrong hostname -> 403', async () => {
  turnstile = { success: true, hostname: 'evil.example' };
  assert.equal((await call(await good())).status, 403);
});
await t('bad signature -> 401', async () => {
  const other = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const r = await call(await good({ idToken: await idToken({}, 'k1', other.privateKey) }));
  assert.equal(r.status, 401); assert.equal(commits.length, 0);
});
await t('expired / wrong project / wrong issuer / unknown kid -> 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const tok of [await idToken({ exp: now - 10 }), await idToken({ aud: 'other' }), await idToken({ iss: 'https://securetoken.google.com/other' }), await idToken({}, 'nokid')]) {
    assert.equal((await call(await good({ idToken: tok }))).status, 401);
  }
  assert.equal(commits.length, 0);
});
await t('bad inputs -> 400', async () => {
  for (const o of [{ level: 'x' }, { rounds: 0 }, { rounds: 21 }, { rounds: 2.5 }, { rounds: '5' }, { autoNames: 'yes' }, { turnstileToken: '' }]) {
    assert.equal((await call(await good(o))).status, 400, JSON.stringify(o));
  }
});
await t('foreign origin refused, no CORS header', async () => {
  const r = await call(await good(), { origin: 'https://evil.example' });
  assert.equal(r.status, 403); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});
await t('preflight OK; wrong path 404; GET 405; unset secrets 500', async () => {
  const p = await call(null, { method: 'OPTIONS' });
  assert.equal(p.status, 204); assert.equal(p.headers.get('Access-Control-Allow-Origin'), 'https://fittheline.com');
  assert.equal((await call(await good(), { path: '/nope' })).status, 404);
  assert.equal((await call(null, { method: 'GET' })).status, 405);
  assert.equal((await call(await good(), { env: {} })).status, 500);
});
// A fake D1 that keeps the counts in a Map, keyed like the table's primary key.
function fakeD1() {
  const rows = new Map();
  return {
    rows,
    prepare: (sql) => ({ bind: (day, ev) => ({ run: async () => {
      assert.match(sql, /ON CONFLICT \(day, event\) DO UPDATE SET n = n \+ 1/);
      rows.set(day + '|' + ev, (rows.get(day + '|' + ev) || 0) + 1);
    } }) })
  };
}
await t('event: known name counts once per call, for today', async () => {
  const STATS = fakeD1();
  for (let i = 0; i < 3; i++) assert.equal((await call({ e: 'solo_round' }, { env: { STATS }, path: '/api/event' })).status, 204);
  assert.equal((await call({ e: 'class_join' }, { env: { STATS }, path: '/api/event' })).status, 204);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(STATS.rows.get(day + '|solo_round'), 3);
  assert.equal(STATS.rows.get(day + '|class_join'), 1);
  assert.equal(STATS.rows.size, 2);
});
await t('event: unknown name, no origin, foreign origin, GET all refused', async () => {
  const STATS = fakeD1();
  assert.equal((await call({ e: 'hack' }, { env: { STATS }, path: '/api/event' })).status, 400);
  assert.equal((await call({ e: 'solo_round' }, { env: { STATS }, path: '/api/event', origin: null })).status, 403);
  assert.equal((await call({ e: 'solo_round' }, { env: { STATS }, path: '/api/event', origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(null, { env: { STATS }, path: '/api/event', method: 'GET' })).status, 405);
  assert.equal(STATS.rows.size, 0);
});
await t('event: works (and counts nothing) without the D1 binding', async () => {
  assert.equal((await call({ e: 'solo_game' }, { env: {}, path: '/api/event' })).status, 204);
});
console.log(n + ' passed');
