import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanion, validateIdToken } from './companion.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';

const extensionId = 'a'.repeat(32);
const origin = `chrome-extension://${extensionId}`;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function jwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const claims = { iss: 'https://auth.openai.com', sub: 'user-1', aud: 'client-1', nonce: 'nonce-1', exp: Math.floor(Date.now() / 1000) + 3600 };
test('ID token validates signature, audience, nonce and expiration', async () => {
  assert.equal((await validateIdToken(jwt(claims), { keys: [jwk] }, 'client-1', 'nonce-1')).sub, 'user-1');
  for (const change of [{ aud: 'other' }, { nonce: 'other' }, { exp: 1 }, { iss: 'https://evil.test' }]) {
    await assert.rejects(() => validateIdToken(jwt({ ...claims, ...change }), { keys: [jwk] }, 'client-1', 'nonce-1'));
  }
  await assert.rejects(() => validateIdToken(jwt(claims).slice(0, -8) + 'AAAAAAAA', { keys: [jwk] }, 'client-1', 'nonce-1'));
});
test('loopback API rejects missing pairing, foreign origin and invalid Host', async t => {
  const app = createCompanion({ extensionId, pairing: 'test-pairing', registration: { hostId: 'urn:uuid:test', accounts: [] }, saveRegistration: async () => {} });
  await app.listen(0); t.after(() => app.close());
  const base = app.baseUrl();
  for (const headers of [{ Origin: origin }, { Origin: 'https://evil.test', Authorization: 'Bearer test-pairing' }]) {
    assert.equal((await fetch(base + '/status', { method: 'POST', headers, body: '{}' })).status, 403);
  }
  const invalidHost = await new Promise(resolve => { const request = http.get(base + '/status', { headers: { Origin: origin, Authorization: 'Bearer test-pairing', Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', resolve); });
  assert.equal(invalidHost, 403);
  const response = await fetch(base + '/status', { method: 'POST', body: '{}', headers: { Origin: origin, Authorization: 'Bearer test-pairing' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connected, false);
  assert.equal((await fetch(base + '/status', { headers: { Origin: origin, Authorization: 'Bearer test-pairing' } })).status, 404);
  assert.equal((await fetch(base + '/models', { headers: { Origin: origin, Authorization: 'Bearer test-pairing' } })).status, 404);
  assert.equal((await fetch(base + '/status', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer test-pairing' } })).status, 403);
});

async function fixture(t, lifetime = 3600) {
  let nonce; let tokenCalls = 0; let incomplete = false; let failRefresh = false; let revoked = false; let saved; let subject = claims.sub; let gate; let notesGate;
  const app = createCompanion({ extensionId, pairing: 'test-pairing', registration: { hostId: 'urn:uuid:test', accounts: [] }, saveRegistration: async value => { saved = value; }, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      tokenCalls += 1;
      const fields = options.body; const tokenNonce = nonce; const tokenSubject = subject;
      if (gate) { const held = gate; gate = undefined; held.enter(options.signal); await held.release; }
      if (fields.get('grant_type') === 'refresh_token') {
        assert.equal(fields.get('refresh_token'), 'refresh-1');
        if (failRefresh) return Response.json({}, { status: 401 });
        return Response.json({ token_type: 'Bearer', access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
      }
      assert.equal(fields.get('client_id'), 'issued-client');
      assert.equal(fields.get('resource'), 'https://api.openai.com/v1');
      assert.ok(fields.get('code_verifier').length >= 43);
      return Response.json({ token_type: 'Bearer', access_token: 'access-1', refresh_token: 'refresh-1', expires_in: lifetime, scope: 'resource.invoke chatgpt.tokens.use.direct', id_token: jwt({ ...claims, aud: 'issued-client', nonce: tokenNonce, sub: tokenSubject }) });
    }
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'account-model', display_name: 'Account model', visibility: 'list' }, { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' }] });
    if (url.endsWith('/responses')) {
      if (notesGate) { const held = notesGate; notesGate = undefined; held.enter(options.signal); await held.release; }
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'account-model'); assert.equal(body.store, false); assert.equal(body.stream, true);
      const delta = 'data: '+JSON.stringify({type:'response.output_text.delta',delta:'Notes'})+'\n\n';
      let stream = delta;
      if (!incomplete) stream += 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
      return new Response(stream);
    }
    if (url.endsWith('/oauth/revoke')) { revoked = true; return new Response(''); }
    throw new Error('Unexpected URL ' + url);
  } });
  await app.listen(0); t.after(() => app.close());
  const request = async (path, body, signal) => {
    let payload = body;
    if (payload === undefined) payload = {};
    const options = { signal, method: 'POST', body: JSON.stringify(payload), headers: { Origin: origin, Authorization: 'Bearer test-pairing', 'Content-Type': 'application/json' } };
    return fetch(app.baseUrl() + path, options);
  };
  const signin = async (clientId = '') => {
    const response = await request('/signin', { clientId }); const url = new URL((await response.json()).url);
    nonce = url.searchParams.get('nonce');
    let expectedClient = clientId; if (!expectedClient) expectedClient = 'dynamic_agent_client';
    assert.equal(url.searchParams.get('client_id'), expectedClient);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return app.baseUrl() + '/auth/callback?code=example-code&client_id=issued-client&state=' + url.searchParams.get('state');
  };
  const pauseToken = () => {
    let enter; let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    gate = { enter, release: held }; return { entered, release };
  };
  const pauseNotes = () => {
    let enter; let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    notesGate = { enter, release: held }; return { entered, release };
  };
  return { request, signin, pauseToken, pauseNotes, changeSubject: value => { subject = value; }, tokenCalls: () => tokenCalls, saved: () => saved, revoked: () => revoked, incomplete: () => { incomplete = true; }, failRefresh: () => { failRefresh = true; } };
}
test('OAuth callback rejects state mismatch and replay; validated session selects entitled model and completes notes', async t => {
  const f = await fixture(t); const callback = await f.signin();
  assert.equal((await fetch(callback.replace(/state=.*/, 'state=wrong'))).status, 400);
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(f.tokenCalls(), 1);
  assert.equal(f.saved().accounts[0].subject, 'user-1');
  assert.equal(JSON.stringify(f.saved()).includes('access-1'), false);
  const models = await (await f.request('/models')).json(); assert.equal(models.models.length, 1);
  assert.equal((await f.request('/model', { model: 'hidden-model' })).status, 400);
  assert.equal((await f.request('/model', { model: 'account-model' })).status, 200);
  assert.equal((await (await f.request('/notes', { instructions: 'Summarize', input: [] })).json()).text, 'Notes');
  f.incomplete(); assert.equal((await f.request('/notes', { instructions: 'Summarize', input: [] })).status, 400);
  assert.equal((await f.request('/signout', {})).status, 200); assert.equal(f.revoked(), true);
  assert.equal((await (await f.request('/status')).json()).connected, false);
});
test('expired tokens refresh once for concurrent requests and failed refresh clears connection', async t => {
  const f = await fixture(t, 1); await fetch(await f.signin());
  const responses = await Promise.all([f.request('/models'), f.request('/models')]);
  assert.ok(responses.every(response => response.status === 200)); assert.equal(f.tokenCalls(), 2);
  const other = await fixture(t, 1); await fetch(await other.signin()); other.failRefresh();
  assert.equal((await other.request('/models')).status, 400);
  assert.equal((await (await other.request('/status')).json()).connected, false);
});
test('cancelled callback never exchanges code', async t => {
  const f = await fixture(t); const callback = new URL(await f.signin()); callback.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.tokenCalls(), 0);
});

test('expired callback is rejected before code exchange', async t => {
  const f = await fixture(t); const callback = await f.signin();
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 300001);
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.tokenCalls(), 0);
});
test('occupied port refuses startup and oversized notes input is rejected', async t => {
  const app = createCompanion({ extensionId, pairing: 'test-pairing', registration: { hostId: 'urn:uuid:test', accounts: [] }, saveRegistration: async () => {} });
  await app.listen(0); t.after(() => app.close());
  const other = createCompanion({ extensionId, pairing: 'test-pairing', registration: { hostId: 'urn:uuid:test', accounts: [] }, saveRegistration: async () => {} });
  await assert.rejects(other.listen(Number(new URL(app.baseUrl()).port)), { code: 'EADDRINUSE' });
  const response = await fetch(app.baseUrl() + '/notes', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer test-pairing' }, body: JSON.stringify({ instructions: 'x'.repeat(1024 * 1024), input: [] }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /too large/);
});


test('returning-account subject mismatch keeps the prior authorized session', async t => {
  const f = await fixture(t); await fetch(await f.signin());
  f.changeSubject('other-user');
  const response = await fetch(await f.signin('issued-client'));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /different account/);
  const status = await (await f.request('/status')).json();
  assert.equal(status.connected, true); assert.equal(status.account.subject, 'user-1');
  assert.equal(f.saved().accounts[0].subject, 'user-1');
});
test('sign-out aborts in-flight exchange and cannot reactivate the session', async t => {
  const f = await fixture(t); const callback = await f.signin();
  const gate = f.pauseToken(); const response = fetch(callback); const signal = await gate.entered;
  assert.equal((await f.request('/signout', {})).status, 200);
  assert.equal(signal.aborted, true); gate.release();
  assert.equal((await response).status, 400);
  assert.equal((await (await f.request('/status')).json()).connected, false);
  assert.equal(f.saved(), undefined);
});
test('superseded exchange cannot activate or persist an earlier sign-in', async t => {
  const f = await fixture(t); const callback = await f.signin();
  const gate = f.pauseToken(); const response = fetch(callback); await gate.entered;
  const replacement = await f.signin(); gate.release();
  const rejected = await response; assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /superseded/);
  assert.equal((await (await f.request('/status')).json()).connected, false);
  assert.equal(f.saved(), undefined);
  assert.equal((await fetch(replacement)).status, 200);
});
test('sign-out aborts refresh and cannot restore cleared credentials', async t => {
  const f = await fixture(t, 1); await fetch(await f.signin());
  const gate = f.pauseToken(); const response = f.request('/models'); const signal = await gate.entered;
  assert.equal((await f.request('/signout', {})).status, 200);
  assert.equal(signal.aborted, true); gate.release();
  assert.equal((await response).status, 400);
  assert.equal((await (await f.request('/status')).json()).connected, false);
});
test('malformed absolute request target returns an error without terminating companion', async t => {
  const script = `import {createCompanion} from './companion.mjs'; const app=createCompanion({extensionId:'${extensionId}',pairing:'test',registration:{hostId:'test',accounts:[]},saveRegistration:async()=>{}}); await app.listen(0); console.log(app.baseUrl());`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const [chunk] = await once(child.stdout, 'data'); const base = new URL(chunk.toString().trim());
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: base.hostname, port: base.port, path: 'http://[', headers: { Host: base.host } }, result => { result.resume(); resolve(result.statusCode); });
    request.setTimeout(2000, () => request.destroy(new Error('Test request timed out')));
    request.on('error', reject); request.end();
  });
  assert.equal(response, 400); assert.equal(child.exitCode, null);
});


async function readyNotes(t) {
  const f = await fixture(t); await fetch(await f.signin()); await f.request('/models');
  await f.request('/model', { model: 'account-model' }); return f;
}
test('client disconnect aborts the upstream notes request', { timeout: 3000 }, async t => {
  const f = await readyNotes(t); const gate = f.pauseNotes(); const client = new AbortController();
  const response = f.request('/notes', { instructions: 'Summarize', input: [] }, client.signal);
  const rejection = assert.rejects(response, { name: 'AbortError' });
  const upstream = await gate.entered;
  const cancelled = new Promise(resolve => upstream.addEventListener('abort', resolve, { once: true }));
  client.abort(); await cancelled; gate.release(); await rejection;
  assert.equal(upstream.aborted, true);
});
test('notes deadline aborts upstream work rather than just abandoning its promise', { timeout: 3000 }, async t => {
  const f = await readyNotes(t); const gate = f.pauseNotes();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = f.request('/notes', { instructions: 'Summarize', input: [] });
  const upstream = await gate.entered;
  t.mock.timers.tick(90001);
  assert.equal(upstream.aborted, true); gate.release();
  const result = await response; assert.equal(result.status, 400);
  assert.match((await result.json()).error, /cancelled or timed out/);
});
