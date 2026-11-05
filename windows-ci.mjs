import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { installWindows, registerWindows } from './windows-helper.mjs';

if (process.platform !== 'win32') throw new Error('This check requires Windows.');
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'Meeting Notes & '));
const destination = join(root, 'helper');
const key = `Software\\MeetingNotesCi\\${randomUUID()}`;
const id = 'a'.repeat(32);
let child;
try {
  await installWindows({ source: process.cwd(), runtime: dirname(process.execPath), destination, extensionId: id, register: async ({ manifest }) => registerWindows({ manifest, registryKey: key }) });
  const registry = await execute('reg.exe', ['query', `HKCU\\${key}`, '/ve']);
  const manifest = join(destination, 'host.json');
  assert.ok(registry.stdout.includes(manifest));
  await assert.rejects(registerWindows({ manifest, registryKey: key }), /already exists/i);
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  assert.deepEqual(saved.allowed_origins, [`chrome-extension://${id}/`]);
  const launcher = join(destination, 'launch-helper.cmd');
  child = spawn('cmd.exe', ['/d', '/s', '/c', `""${launcher}" "chrome-extension://${id}/""`], {
    windowsVerbatimArguments: true, env: { ...process.env, USERPROFILE: root, HOME: root }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', value => { stderr += value.toString(); });
  const body = Buffer.from(JSON.stringify({ type: 'connect' })); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
  const answer = await new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error(`Native host timed out: ${stderr}`)), 15000);
    child.stdout.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) { clearTimeout(timer); resolve(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)))); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native host exited ${code}: ${stderr}`)); });
  });
  assert.equal(typeof answer.pairingCode, 'string');
  const response = await fetch('http://127.0.0.1:1455/status', { method: 'POST', headers: { Origin: `chrome-extension://${id}`, Authorization: `Bearer ${answer.pairingCode}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).connected, false);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end(); assert.equal(await exited, 0);
  console.log('Windows native launcher, registry isolation, framing and loopback status passed.');
} finally {
  if (child && child.exitCode === null) child.kill();
  await execute('reg.exe', ['delete', `HKCU\\${key}`, '/f']).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
