import { mkdir, cp, copyFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const registryPath = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.meeting_notes.helper';

// RegCreateKeyEx reports whether the key was newly created, avoiding a check/create race.
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MeetingNotesRegistry {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegCreateKeyEx(IntPtr root, string path, int reserved, string cls, int options, int access, IntPtr security, out IntPtr key, out int disposition);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegSetValueEx(IntPtr key, string name, int reserved, int type, byte[] data, int size);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegDeleteKey(IntPtr root, string path);
  public static void Register(string path, string manifest) {
    IntPtr root = new IntPtr(unchecked((int)0x80000001)); IntPtr key; int disposition;
    int status = RegCreateKeyEx(root, path, 0, null, 0, 0x20006, IntPtr.Zero, out key, out disposition);
    if (status != 0) throw new System.ComponentModel.Win32Exception(status);
    if (disposition != 1) { RegCloseKey(key); throw new InvalidOperationException("Native host registration already exists."); }
    byte[] data = Encoding.Unicode.GetBytes(manifest + "\0");
    status = RegSetValueEx(key, null, 0, 1, data, data.Length); RegCloseKey(key);
    if (status != 0) { int cleanup = RegDeleteKey(root, path); if (cleanup != 0) throw new InvalidOperationException("Registration failed and registry cleanup failed: " + cleanup); throw new System.ComponentModel.Win32Exception(status); }
  }
}
'@
[MeetingNotesRegistry]::Register($env:MEETING_REGISTRY_PATH, $env:MEETING_HOST_MANIFEST)
`;

export async function registerWindows({ manifest, registryKey = registryPath }) {
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryScript], {
    env: { ...process.env, MEETING_REGISTRY_PATH: registryKey, MEETING_HOST_MANIFEST: manifest }, windowsHide: true
  });
}

async function installDependencies(destination) {
  const runtime = join(destination, 'runtime');
  const executable = join(runtime, 'node.exe');
  const npm = join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await execute(executable, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, windowsHide: true });
}

export async function installWindows({ source, runtime, destination, extensionId, register = registerWindows, installDependencies: install = installDependencies }) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Extension ID must contain 32 letters from a to p.');
  let owned = false;
  try {
    try { await mkdir(destination); owned = true; }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Meeting Notes helper folder already exists. Remove it only if it belongs to this installation.'); throw error; }
    await cp(runtime, join(destination, 'runtime'), { recursive: true, errorOnExist: true });
    for (const name of ['companion.mjs', 'core.mjs', 'native-host.mjs', 'package.json', 'package-lock.json']) await copyFile(join(source, name), join(destination, name));
    await install(destination);
    const launcher = join(destination, 'launch-helper.cmd');
    const script = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0runtime\\node.exe" "%~dp0companion.mjs" --native ${extensionId} %*\r\n`;
    await writeFile(launcher, script, { flag: 'wx' });
    const manifest = join(destination, 'host.json');
    await writeFile(manifest, JSON.stringify({ name: 'com.meeting_notes.helper', description: 'Meeting Notes local helper', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2) + '\n', { flag: 'wx' });
    await register({ manifest });
  } catch (error) {
    if (owned) await rm(destination, { recursive: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = dirname(fileURLToPath(import.meta.url));
  const { MEETING_EXTENSION_ID: extensionId, MEETING_RUNTIME_DIR: runtime, LOCALAPPDATA: localAppData } = process.env;
  if (!localAppData || !runtime) throw new Error('Run Setup Meeting Notes.cmd on Windows.');
  await installWindows({ source, runtime, destination: join(localAppData, 'MeetingNotesHelper'), extensionId });
  console.log('Helper installed. Return to Chrome and reload Meeting Notes.');
}
