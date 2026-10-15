// Fit the Line: create-class Worker.
//
// A teacher's browser asks this Worker to create a class. The Worker:
//   1. checks the teacher's Firebase sign-in token (so the class is owned by the right user),
//   2. checks a Cloudflare Turnstile token (so it is a real browser, not a script),
//   3. writes the class and its head-count document to Firestore with a service account.
// Students never call this. They join, play and watch the class exactly as before.
//
// Secrets (set with `wrangler secret put`, never committed):
//   TURNSTILE_SECRET            the Turnstile widget's secret key
//   FIREBASE_SERVICE_ACCOUNT    the service account key JSON, as one string

const PROJECT_ID = 'trendlinegame';
const ALLOWED_ORIGINS = ['https://fittheline.com', 'https://www.fittheline.com'];
const ALLOWED_HOSTNAMES = ['fittheline.com', 'www.fittheline.com'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_CODE_ATTEMPTS = 6;
const CLASS_LIFETIME_MS = 24 * 3600 * 1000;

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DB_ROOT = `projects/${PROJECT_ID}/databases/(default)`;
const FIRESTORE_ROOT = `${DB_ROOT}/documents`;

// Kept between requests while the Worker instance stays warm.
let jwksCache = { keys: null, at: 0 };
let accessTokenCache = { token: null, expires: 0 };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- small helpers ----------

function cors(origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function reply(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }
  });
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseJson(b64url) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url)));
}

function randomInt(max) {
  // Unbiased enough for a 24-letter alphabet and a 32-bit seed.
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % max;
}

function newCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS.charAt(randomInt(CODE_CHARS.length));
  return s;
}

// ---------- 1. the teacher's Firebase sign-in token ----------

async function getJwks(forceRefresh) {
  const fresh = jwksCache.keys && Date.now() - jwksCache.at < 3600 * 1000;
  if (fresh && !forceRefresh) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new HttpError(502, 'Could not check your sign-in.');
  const { keys } = await res.json();
  jwksCache = { keys, at: Date.now() };
  return keys;
}

// Returns the user's uid if the token is a valid, unexpired Firebase ID token for this project.
async function verifyIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Bad sign-in token.');
  let header, payload;
  try { header = parseJson(parts[0]); payload = parseJson(parts[1]); }
  catch (e) { throw new HttpError(401, 'Bad sign-in token.'); }

  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'Bad sign-in token.');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new HttpError(401, 'Bad sign-in token.');
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new HttpError(401, 'Bad sign-in token.');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new HttpError(401, 'Your sign-in expired. Reload the page.');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new HttpError(401, 'Bad sign-in token.');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new HttpError(401, 'Bad sign-in token.');

  let keys = await getJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getJwks(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new HttpError(401, 'Bad sign-in token.');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!ok) throw new HttpError(401, 'Bad sign-in token.');
  return payload.sub;
}

// ---------- 2. Cloudflare Turnstile ----------

async function verifyTurnstile(token, ip, secret) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  let res;
  try { res = await fetch(TURNSTILE_URL, { method: 'POST', body: form }); }
  catch (e) { throw new HttpError(502, 'Could not run the human check.'); }
  if (!res.ok) throw new HttpError(502, 'Could not run the human check.');
  const out = await res.json();
  if (!out.success) throw new HttpError(403, 'The human check did not pass. Reload the page and try again.');
  if (out.hostname && !ALLOWED_HOSTNAMES.includes(out.hostname)) {
    throw new HttpError(403, 'The human check did not pass. Reload the page and try again.');
  }
}

// ---------- 3. Firestore, as a service account ----------

async function getAccessToken(env) {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expires - 300 * 1000) return accessTokenCache.token;

  let sa;
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
  catch (e) { throw new HttpError(500, 'The class server is not set up yet.'); }
  if (!sa.client_email || !sa.private_key) throw new HttpError(500, 'The class server is not set up yet.');

  const iat = Math.floor(Date.now() / 1000);
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600
  });
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + bytesToB64url(sig)
    })
  });
  if (!res.ok) throw new HttpError(502, 'The class server could not sign in.');
  const out = await res.json();
  accessTokenCache = { token: out.access_token, expires: Date.now() + (out.expires_in || 3600) * 1000 };
  return out.access_token;
}

function int(n) { return { integerValue: String(n) }; }

// Same fields the page used to write itself, plus a roster document that starts the head count at 0.
function buildWrites(code, uid, level, rounds, autoNames, now) {
  const expiresAt = new Date(now + CLASS_LIFETIME_MS).toISOString();
  return [
    {
      update: {
        name: `${FIRESTORE_ROOT}/classes/${code}`,
        fields: {
          hostUid: { stringValue: uid },
          level: { stringValue: level },
          rounds: int(rounds),
          seed: int(randomInt(4294967296)),
          status: { stringValue: 'lobby' },
          phase: { stringValue: 'lobby' },
          round: int(0),
          board: { arrayValue: {} },
          createdAt: int(now),
          expiresAt: { timestampValue: expiresAt },
          autoNames: { booleanValue: autoNames }
        }
      },
      currentDocument: { exists: false }
    },
    {
      update: {
        name: `${FIRESTORE_ROOT}/classes/${code}/meta/roster`,
        fields: { count: int(0), expiresAt: { timestampValue: expiresAt } }
      }
    }
  ];
}

async function createClass(env, uid, level, rounds, autoNames) {
  const token = await getAccessToken(env);
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = newCode();
    const now = Date.now();
    const res = await fetch(`https://firestore.googleapis.com/v1/${DB_ROOT}/documents:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: buildWrites(code, uid, level, rounds, autoNames, now) })
    });
    if (res.ok) return { code, expiresAt: now + CLASS_LIFETIME_MS };
    let status = '';
    try { status = (await res.json()).error.status; } catch (e) { /* not JSON */ }
    // That code is already in use by a live class: try another.
    if (res.status === 409 || status === 'ALREADY_EXISTS' || status === 'FAILED_PRECONDITION') continue;
    throw new HttpError(502, 'The class server could not create the class.');
  }
  throw new HttpError(503, 'Could not find a free class code. Try again.');
}

// ---------- request handling ----------

async function handle(request, env) {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (url.pathname !== '/api/create-class' && url.pathname !== '/create-class') throw new HttpError(404, 'Not found.');
  if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'Not allowed from this site.');
  if (!env.TURNSTILE_SECRET || !env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(500, 'The class server is not set up yet.');

  const raw = await request.text();
  if (raw.length > 8000) throw new HttpError(413, 'Request too large.');
  let body;
  try { body = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Bad request.'); }

  const { level, rounds, autoNames, turnstileToken, idToken } = body || {};
  if (!['easy', 'medium', 'hard'].includes(level)) throw new HttpError(400, 'Bad difficulty.');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new HttpError(400, 'Bad round count.');
  if (typeof autoNames !== 'boolean') throw new HttpError(400, 'Bad fun-names setting.');
  if (typeof turnstileToken !== 'string' || !turnstileToken || turnstileToken.length > 2048) throw new HttpError(400, 'Missing human check.');
  if (typeof idToken !== 'string' || !idToken || idToken.length > 4096) throw new HttpError(401, 'Missing sign-in.');

  const uid = await verifyIdToken(idToken);
  await verifyTurnstile(turnstileToken, request.headers.get('CF-Connecting-IP'), env.TURNSTILE_SECRET);
  const made = await createClass(env, uid, level, rounds, autoNames);
  return reply(200, made, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message }, origin);
      return reply(500, { error: 'Something went wrong.' }, origin);
    }
  }
};
