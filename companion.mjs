import { nativeConnection } from './native-host.mjs';
import http from 'node:http';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readNotes } from './core.mjs';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const random = () => randomBytes(32).toString('base64url');
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}.`);
  return value;
}
export async function validateIdToken(token, jwks, clientId, nonce) {
  const { payload } = await jwtVerify(requireString(token, 'ID token'), createLocalJWKSet(jwks), {
    issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'nonce']
  });
  if (!same(payload.nonce, nonce)) throw new Error('Invalid ID token nonce.');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error('Invalid authorized party.');
  requireString(payload.sub, 'account identity');
  return payload;
}
async function limitedText(response, maxBytes) {
  if (!response.body) throw new Error('Empty provider response.');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new Error('Provider response is too large.');
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function providerJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid JSON from OpenAI.'); }
}
export function createCompanion({ extensionId, pairing, registration, saveRegistration, fetchImpl = fetch }) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Provide a valid Chrome extension ID.');
  const origin = `chrome-extension://${extensionId}`;
  let generation = 0; let pending; let session; let refresh; let authError; let model; let models = [];
  const work = new Set();
  let port;
  const baseUrl = () => `http://127.0.0.1:${port}`;
  async function request(url, options, signal, maxBytes = 1024 * 1024) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal });
    const text = await limitedText(response, maxBytes);
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}). Reconnect if authorization has expired.`);
    return text;
  }
  async function tokenRequest(fields, signal) {
    return providerJson(await request(issuer + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }, signal));
  }
  function credentials(data, previousScopes) {
    if (data.token_type !== 'Bearer' && data.token_type !== 'bearer') throw new Error('Unsupported OAuth token type.');
    if (!Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid token expiry.');
    let scopes = previousScopes;
    if (typeof data.scope === 'string') scopes = data.scope.split(/\s+/);
    if (!Array.isArray(scopes) || !scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) throw new Error('ChatGPT plan usage was not authorized.');
    return { accessToken: requireString(data.access_token, 'access token'), refreshToken: requireString(data.refresh_token, 'refresh token'), expiresAt: Date.now() + data.expires_in * 1000, scopes };
  }
  async function access(signal) {
    if (!session) throw new Error('Continue with ChatGPT before generating notes.');
    if (session.expiresAt > Date.now() + 60000) return session;
    if (!refresh) {
      const current = session;
      refresh = (async () => {
        const controller = new AbortController(); work.add(controller);
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const data = await tokenRequest({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken, resource }, controller.signal);
          const updated = credentials(data, current.scopes);
          if (session !== current) throw new Error('Account changed during refresh.');
          session = { ...current, ...updated };
          return session;
        } catch (error) {
          if (session === current) session = undefined;
          throw error;
        } finally { clearTimeout(timer); work.delete(controller); }
      })().finally(() => { refresh = undefined; });
    }
    const result = await refresh; signal.throwIfAborted(); return result;
  }
  async function catalog(signal) {
    const current = await access(signal);
    const data = providerJson(await request(resource + '/models', { headers: { Authorization: `Bearer ${current.accessToken}` } }, signal));
    if (!Array.isArray(data.models)) throw new Error('Invalid model catalog.');
    const available = data.models.filter(item => item.visibility === 'list' && typeof item.slug === 'string' && typeof item.display_name === 'string').map(item => ({ id: item.slug, name: item.display_name }));
    if (session !== current) throw new Error('Account changed while loading models.');
    models = available;
    if (!models.some(item => item.id === model)) model = undefined;
    return models;
  }
  function disconnect() {
    generation += 1; const old = session; session = undefined; pending = undefined; model = undefined; models = [];
    for (const controller of work) controller.abort();
    return old;
  }
  async function callback(url, signal) {
    const attempt = pending;
    if (!attempt || !same(url.searchParams.get('state'), attempt.state) || Date.now() >= attempt.expiresAt) throw new Error('Invalid or expired sign-in callback.');
    pending = undefined;
    if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was cancelled or denied.');
    let clientId = url.searchParams.get('client_id');
    if (attempt.account) {
      if (clientId !== null && clientId !== attempt.account.clientId) throw new Error('Sign-in client changed.');
      clientId = attempt.account.clientId;
    }
    if (!clientId || clientId === 'dynamic_agent_client' || !/^[A-Za-z0-9_-]{1,200}$/.test(clientId)) throw new Error('Registration did not return an issued client ID.');
    const code = requireString(url.searchParams.get('code'), 'authorization code');
    const data = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource }, signal);
    const jwks = providerJson(await request(issuer + '/.well-known/jwks.json', {}, signal));
    const identity = await validateIdToken(data.id_token, jwks, clientId, attempt.nonce);
    if (attempt.account && identity.sub !== attempt.account.subject) throw new Error('Sign-in returned a different account.');
    const next = { ...credentials(data), clientId, subject: identity.sub };
    let label = identity.sub;
    if (typeof identity.email === 'string') label = identity.email;
    const account = { clientId, subject: identity.sub, label };
    const accounts = registration.accounts.filter(item => item.clientId !== clientId);
    accounts.push(account);
    signal.throwIfAborted();
    if (attempt.generation !== generation) throw new Error('Sign-in was superseded.');
    await saveRegistration({ ...registration, accounts });
    signal.throwIfAborted();
    if (attempt.generation !== generation) throw new Error('Sign-in was superseded.');
    registration.accounts = accounts;
    session = next; model = undefined; models = []; authError = undefined;
  }
  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request too large.'); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value;
  }
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) { send(res, 403, { error: 'Invalid host.' }); return; }
    let url;
    try { url = new URL(req.url, baseUrl()); }
    catch { send(res, 400, { error: 'Invalid request target.' }); return; }
    const isCallback = req.method === 'GET' && url.pathname === '/auth/callback';
    if (!isCallback) {
      if (req.headers.origin !== origin) { send(res, 403, { error: 'Invalid origin.' }); return; }
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '0' }); res.end(); return;
      }
      if (!same(req.headers.authorization, `Bearer ${pairing}`)) { send(res, 403, { error: 'Pairing code is missing or incorrect.' }); return; }
    }
    const controller = new AbortController(); work.add(controller);
    let timeout = 20000; if (url.pathname === '/notes') timeout = 90000;
    const timer = setTimeout(() => { controller.abort(); if (!req.complete) req.destroy(); }, timeout);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose); req.on('aborted', onClose);
    try {
      let result;
      if (isCallback) {
        try { await callback(url, controller.signal); }
        catch (error) { authError = error.message; throw error; }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" }); res.end('ChatGPT connected. Return to Meeting Notes and click Refresh connection.'); return;
      } else if (req.method === 'POST' && url.pathname === '/status') {
        await readBody(req);
        result = { connected: Boolean(session), accounts: registration.accounts, models, model, authError };
        if (session) result.account = registration.accounts.find(item => item.clientId === session.clientId);
      } else if (req.method === 'POST' && url.pathname === '/models') {
        await readBody(req);
        result = { models: await catalog(controller.signal), model };
      } else if (req.method === 'POST' && url.pathname === '/signin') {
        const body = await readBody(req); let account;
        if (body.clientId !== undefined && body.clientId !== '') {
          account = registration.accounts.find(item => item.clientId === body.clientId);
          if (!account) throw new Error('Unknown saved account.');
        }
        const verifier = random(); const nonce = random(); const state = random();
        const redirectUri = baseUrl() + '/auth/callback';
        generation += 1;
        pending = { generation, verifier, nonce, state, account, redirectUri, expiresAt: Date.now() + 300000 };
        const authorization = new URL(issuer + '/api/accounts/authorize');
        let clientId = 'dynamic_agent_client'; if (account) clientId = account.clientId;
        const parameters = { client_id: clientId, ext_agent_host_id: registration.hostId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
        if (!account) parameters.agent_name_hint = 'Meeting Notes';
        for (const [name, value] of Object.entries(parameters)) authorization.searchParams.set(name, value);
        authError = undefined; result = { url: authorization.href };
      } else if (req.method === 'POST' && url.pathname === '/signout') {
        // Stop other work before revoking, without aborting this sign-out request.
        work.delete(controller); const old = disconnect(); work.add(controller);
        let revoked = true;
        if (old) {
          try { await request(issuer + '/api/accounts/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: old.refreshToken, token_type_hint: 'refresh_token', client_id: old.clientId }) }, controller.signal); }
          catch { revoked = false; }
        }
        result = { ok: true, revoked };
      } else if (req.method === 'POST' && url.pathname === '/model') {
        const body = await readBody(req);
        if (!session || !models.some(item => item.id === body.model)) throw new Error('Choose a model from this account’s catalog.');
        model = body.model; result = { ok: true };
      } else if (req.method === 'POST' && url.pathname === '/notes') {
        const body = await readBody(req);
        if (!model) throw new Error('Choose a notes model first.');
        if (typeof body.instructions !== 'string' || !Array.isArray(body.input)) throw new Error('Invalid notes request.');
        const current = await access(controller.signal);
        const payload = { model, instructions: body.instructions, input: body.input, store: false, stream: true };
        const stream = await request(resource + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${current.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(payload) }, controller.signal, 2 * 1024 * 1024);
        if (session !== current) throw new Error('Account changed during note generation.');
        result = { text: readNotes(stream) };
      } else { send(res, 404, { error: 'Unknown request.' }); return; }
      send(res, 200, result);
    } catch (error) {
      let message = error.message;
      if (controller.signal.aborted && error.name === 'AbortError') message = 'Request cancelled or timed out.';
      if (!res.destroyed) send(res, 400, { error: message });
    } finally { clearTimeout(timer); work.delete(controller); res.off('close', onClose); req.off('aborted', onClose); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  return {
    baseUrl,
    listen: async selectedPort => {
      await new Promise((accept, reject) => { server.once('error', reject); server.listen(selectedPort, '127.0.0.1', () => { server.off('error', reject); port = server.address().port; accept(); }); });
    },
    close: async () => { disconnect(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const native = args[0] === '--native';
  if (args.length < 2 || (args[0] !== '--extension-id' && !native) || (native && args[2] !== `chrome-extension://${args[1]}/`)) throw new Error('Invalid companion launch arguments.');
  const dir = join(homedir(), '.config', 'meeting-notes'); await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
  const file = join(dir, 'registration.json'); let registration;
  try { registration = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; registration = { hostId: `urn:uuid:${randomUUID()}`, accounts: [] }; }
  if (typeof registration.hostId !== 'string' || !Array.isArray(registration.accounts)) throw new Error('Invalid registration file.');
  const saveRegistration = async data => {
    const temporary = file + '.' + random() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  await saveRegistration(registration);
  const pairing = random();
  const app = createCompanion({ extensionId: args[1], pairing, registration, saveRegistration });
  await app.listen(1455);
  if (native) {
    nativeConnection(process.stdin, process.stdout, pairing, async () => { await app.close(); process.exit(0); });
    process.stdin.resume();
    return;
  }
  console.log('Meeting Notes companion: http://127.0.0.1:1455');
  console.log('Pairing code (paste only into your extension):', pairing);
  console.log('Keep this terminal open. OAuth tokens stay in memory; restart requires sign-in.');
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
