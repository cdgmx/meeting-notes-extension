import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { nativeConnection } from './native-host.mjs';

test('native protocol returns the pairing secret and closes once on disconnect', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const chunks = []; let closed = 0;
  output.on('data', chunk => chunks.push(chunk));
  nativeConnection(input, output, 'private-pairing', async () => { closed++; });
  const body = Buffer.from(JSON.stringify({ type: 'connect' })); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  input.write(header.subarray(0, 2)); input.write(Buffer.concat([header.subarray(2), body]));
  await new Promise(resolve => setImmediate(resolve));
  const data = Buffer.concat(chunks); assert.equal(data.readUInt32LE(0), data.length - 4);
  assert.deepEqual(JSON.parse(data.subarray(4)), { pairingCode: 'private-pairing' });
  input.end(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1);
});

test('installer registers only the supplied extension and refuses to replace a host', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const home = await mkdtemp(join(tmpdir(), 'meeting-native-test-')); const run = promisify(execFile); const id = 'a'.repeat(32);
  try {
    await run(process.execPath, ['install-helper.mjs', '--extension-id', id], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    const host = JSON.parse(await readFile(join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.meeting_notes.helper.json'), 'utf8'));
    assert.deepEqual(host.allowed_origins, [`chrome-extension://${id}/`]); assert.equal(host.type, 'stdio');
    await assert.rejects(run(process.execPath, ['install-helper.mjs', '--extension-id', id], { env: { ...process.env, HOME: home, USERPROFILE: home } }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('native connection rejects malformed and oversized messages without returning a secret', async () => {
  for (const message of [Buffer.from([1, 0, 0, 0, 123]), Buffer.from([1, 16, 0, 0])]) {
    const input = new PassThrough(); const output = new PassThrough(); let closed = 0; let sent = false;
    output.on('data', () => { sent = true; });
    nativeConnection(input, output, 'private-pairing', async () => { closed++; });
    input.write(message); await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1); assert.equal(sent, false);
  }
});

test('native helper rejects a different launch origin before starting', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['companion.mjs', '--native', 'a'.repeat(32), `chrome-extension://${'b'.repeat(32)}/`], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Invalid companion launch arguments/); assert.equal(result.stdout, '');
});
