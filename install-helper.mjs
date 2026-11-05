import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--extension-id' || !/^[a-p]{32}$/.test(args[1])) throw new Error('Usage: node install-helper.mjs --extension-id YOUR_CHROME_EXTENSION_ID');
const folder = dirname(fileURLToPath(import.meta.url));
const home = homedir();
const directory = join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
const manifest = join(directory, 'com.meeting_notes.helper.json');
const launcher = join(directory, 'com.meeting_notes.helper.sh');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await mkdir(directory, { recursive: true, mode: 0o700 });
let createdLauncher = false; let createdManifest = false;
try {
  const script = await open(launcher, 'wx', 0o700); createdLauncher = true;
  try { await script.writeFile(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(folder, 'companion.mjs'))} --native ${quote(args[1])} "$@"\n`); } finally { await script.close(); }
  const file = await open(manifest, 'wx', 0o600); createdManifest = true;
  try { await file.writeFile(JSON.stringify({ name: 'com.meeting_notes.helper', description: 'Meeting Notes local helper', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${args[1]}/`] }, null, 2) + '\n'); } finally { await file.close(); }
} catch (error) {
  if (createdManifest) await unlink(manifest);
  if (createdLauncher) await unlink(launcher);
  throw error;
}
console.log('Meeting Notes helper installed for this Chrome extension.');
