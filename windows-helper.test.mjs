import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installWindows } from './windows-helper.mjs';

test('install restricts host to requested extension and refuses an existing installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-win-test-')); const source = join(root, 'source'); const runtime = join(root, 'runtime'); const destination = join(root, 'space & percent % destination');
  try {
    await mkdir(source); await mkdir(runtime); await writeFile(join(runtime, 'node.exe'), 'fake');
    for (const name of ['companion.mjs', 'core.mjs', 'native-host.mjs', 'package.json', 'package-lock.json']) await writeFile(join(source, name), 'test');
    let registered; const register = async value => { registered = value; };
    await installWindows({ source, runtime, destination, extensionId: 'a'.repeat(32), register, installDependencies: async () => {} });
    const manifest = JSON.parse(await readFile(registered.manifest, 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]); assert.equal(manifest.type, 'stdio');
    const launcher = await readFile(join(destination, 'launch-helper.cmd'), 'utf8'); assert.match(launcher, /@echo off/i); assert.match(launcher, /--native a{32} %\*/);
    await assert.rejects(installWindows({ source, runtime, destination, extensionId: 'a'.repeat(32), register, installDependencies: async () => {} }), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registration failure removes only the newly created installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-win-test-')); const source = join(root, 'source'); const runtime = join(root, 'runtime'); const destination = join(root, 'destination');
  try {
    await mkdir(source); await mkdir(runtime); await writeFile(join(runtime, 'node.exe'), 'fake');
    for (const name of ['companion.mjs', 'core.mjs', 'native-host.mjs', 'package.json', 'package-lock.json']) await writeFile(join(source, name), 'test');
    await assert.rejects(installWindows({ source, runtime, destination, extensionId: 'b'.repeat(32), register: async () => { throw new Error('registration failed'); }, installDependencies: async () => {} }), /registration failed/);
    await assert.rejects(access(destination)); await access(join(source, 'companion.mjs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('rejects invalid extension IDs before creating an installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-win-test-')); const destination = join(root, 'new');
  try {
    await assert.rejects(installWindows({ source: root, runtime: root, destination, extensionId: 'a'.repeat(31) + '&', register: async () => {}, installDependencies: async () => {} }), /Extension ID/);
    await assert.rejects(access(destination));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bootstrap verifies a pinned official runtime before extraction and does not alter execution policy', async () => {
  const script = await readFile(new URL('./Setup Meeting Notes.cmd', import.meta.url), 'utf8');
  assert.match(script, /https:\/\/nodejs\.org\/dist\/v22\.23\.4\/node-v22\.23\.4-win-x64\.zip/);
  assert.match(script, /CBC74B5E0982C9DBB41525FD8FB5DCD32FBEE237863F7829072F4639A1CE5F20/);
  assert.match(script, /if \(\$hash -cne 'CBC74B5E0982C9DBB41525FD8FB5DCD32FBEE237863F7829072F4639A1CE5F20'\) \{ throw/i);
  assert.ok(script.indexOf('ComputeHash') < script.indexOf('tar.exe'));
  assert.match(script, /if errorlevel 1 goto cleanup_failed\r?\n[^\r\n]*tar\.exe/i);
  assert.doesNotMatch(script, /Get-FileHash|Expand-Archive/);
  assert.doesNotMatch(script, /ExecutionPolicy/i);
});
