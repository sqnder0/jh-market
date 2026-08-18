// HTTP-level tests for the access gate: the board is open to the room, and
// nothing else is — including the data on the wire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');
const PASSWORD = 'jenneissexy';

let child;
let base;
let dataDir;

async function startServer() {
  dataDir = await mkdtemp(path.join(tmpdir(), 'jh-market-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

test.before(startServer);
test.after(async () => {
  child?.kill('SIGKILL');
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const get = (p, cookie) =>
  fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });

const post = (p, body, cookie) =>
  fetch(base + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });

async function login() {
  const res = await post('/api/login', { password: PASSWORD });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  return setCookie.split(';')[0];
}

test('the board and the login page are open to anyone', async () => {
  for (const page of ['/market', '/login']) {
    assert.equal((await get(page)).status, 200, `${page} is public`);
  }
  assert.equal((await get('/api/health')).status, 200, 'health probes need no session');
  assert.equal((await get('/css/app.css')).status, 200, 'assets the board needs are served');
});

test('every other page redirects to the login screen', async () => {
  for (const page of ['/', '/clock', '/desk', '/private', '/admin']) {
    const res = await get(page);
    assert.equal(res.status, 302, `${page} is gated`);
    assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(page)}`);
  }
});

test('a public stream carries no private listings, positions or book', async () => {
  const res = await get('/api/state');
  assert.equal(res.status, 200);
  const state = await res.json();

  assert.equal(state.authed, false);
  assert.equal(state.portfolio, null, 'the dealer book is withheld');
  assert.deepEqual(state.equityHistory, []);
  assert.ok(state.businesses.length > 0, 'the board still gets its listings');
  assert.ok(
    state.businesses.every((b) => b.market === 'public'),
    'the private book never reaches an anonymous viewer',
  );
  assert.ok(
    state.businesses.every((b) => b.position === null),
    'holdings are withheld too',
  );
});

test('commands are refused without a session', async () => {
  for (const [endpoint, body] of [
    ['/api/clock', { running: false }],
    ['/api/pump', { id: 'x', percent: 100 }],
    ['/api/trade', { id: 'x', side: 'buy', qty: 1 }],
    ['/api/business/create', { name: 'Sneaky' }],
    ['/api/schedule', { dayEnd: 23 }],
    ['/api/market/reset', {}],
  ]) {
    const res = await post(endpoint, body);
    assert.equal(res.status, 401, `${endpoint} needs a session`);
  }

  const after = await (await get('/api/state')).json();
  assert.equal(after.clock.running, true, 'the refused commands changed nothing');
});

test('the wrong password gets you nothing', async () => {
  const res = await post('/api/login', { password: 'jenniseasy' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null, 'no cookie is handed out');
});

test('a forged cookie does not pass', async () => {
  assert.equal((await get('/admin', 'jhm_auth=letmein')).status, 302);
  assert.equal((await get('/admin', `jhm_auth=${'a'.repeat(64)}`)).status, 302);
});

test('the password opens every page, the full book, and the commands', async () => {
  const cookie = await login();

  for (const page of ['/', '/clock', '/desk', '/private', '/admin', '/market']) {
    assert.equal((await get(page, cookie)).status, 200, `${page} opens`);
  }

  const state = await (await get('/api/state', cookie)).json();
  assert.equal(state.authed, true);
  assert.ok(state.portfolio, 'the book is visible');
  assert.ok(state.businesses.some((b) => b.market === 'private'), 'private listings are visible');

  assert.equal((await post('/api/clock', { running: false }, cookie)).status, 200);
  const after = await (await get('/api/state', cookie)).json();
  assert.equal(after.clock.running, false, 'the command landed');
});

test('logging out closes the door again', async () => {
  const cookie = await login();
  assert.equal((await get('/admin', cookie)).status, 200);

  const res = await post('/api/logout', {}, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});
