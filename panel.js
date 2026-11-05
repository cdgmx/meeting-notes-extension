const $ = id => document.getElementById(id);
const defaultPrompt = 'Create concise meeting notes with key points, decisions, and action items. Do not invent details.';
let active = false; let busy = false; let statusError = false; let statusUnknown = false;
let companionAvailable = false; let notesConnected = false;
function connectionControls() {
  $('signin').disabled = busy || !companionAvailable;
  $('signout').disabled = busy || !notesConnected;
  $('model').disabled = busy || !notesConnected;
  $('account').disabled = busy;
  $('connect').disabled = busy;
}
function render(data) {
  if (data.active !== undefined) active = data.active;
  if (data.busy !== undefined) busy = data.busy;
  if (data.status !== undefined) {
    let message = data.status;
    statusError = false;
    statusUnknown = data.statusError === undefined;
    if (data.statusError === true) statusError = true;
    if (message.includes('Transcript correction has an invalid segment count.')) {
      statusError = true; statusUnknown = false;
      message = 'Some audio was discarded. Your notes and transcript are saved. Select Start listening to try again.';
    }
    $('status').textContent = message;
  }
  if (data.status === undefined && data.statusError !== undefined) { statusError = data.statusError; statusUnknown = false; }
  connectionControls();
  $('start').disabled = busy || active; $('stop').disabled = !active; $('clear').disabled = busy;
  $('start').classList.toggle('recording', active);
  if (active) $('start').textContent = 'Listening…';
  else $('start').textContent = 'Start listening';
  if (active) $('label').textContent = 'Listening';
  else if (busy) $('label').textContent = 'Finishing';
  else if (statusError) $('label').textContent = 'Attention needed';
  else if (statusUnknown) $('label').textContent = 'Status';
  else $('label').textContent = 'Ready to listen';
  $('dot').classList.toggle('active', active);
  for (const name of ['notes', 'transcript']) if (data[name] !== undefined) $(name).value = data[name];
  if (data.segments !== undefined) $('original').value = data.segments.map(segment => segment.raw).join('\n\n');
  if (data.prompt !== undefined && document.activeElement !== $('prompt')) $('prompt').value = data.prompt;
}
const saved = await chrome.storage.local.get(['active', 'busy', 'status', 'statusError', 'notes', 'transcript', 'prompt', 'segments']);
let storedStatusError = saved.statusError;
if (saved.prompt === undefined) saved.prompt = defaultPrompt;
if (saved.segments === undefined && saved.transcript) saved.segments = [{ raw: saved.transcript, corrected: saved.transcript }];
render({ active: false, busy: false, ...saved });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const values = {};
  for (const [key, change] of Object.entries(changes)) values[key] = change.newValue;
  if (changes.statusError !== undefined) storedStatusError = changes.statusError.newValue;
  if (changes.status !== undefined && changes.statusError === undefined && storedStatusError !== undefined) values.statusError = storedStatusError;
  render(values);
});
for (const name of ['prompt']) $(name).addEventListener('input', () => { void chrome.storage.local.set({ [name]: $(name).value }); });
$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try { const connection = await companion('/status'); if (!connection.connected || !connection.model) throw new Error('Open Notes connection, sign in and choose a notes model first.'); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error('No active tab found.'); const result = await chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId: tab.id }); if (result?.error) throw new Error(result.error); }
  catch (error) { render({ active: false, status: error.message, statusError: true }); }
});
$('stop').addEventListener('click', async () => { $('stop').disabled = true; try { const result = await chrome.runtime.sendMessage({ target: 'capture', type: 'stop' }); if (result?.error) throw new Error(result.error); } catch (error) { render({ active: false, status: error.message, statusError: true }); } });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('notes').value); $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy notes'; }, 2000); } catch { render({ status: 'Could not copy notes. Select the text and copy it.', statusError: true }); } });
$('clear').addEventListener('click', async () => { if (busy) return; await chrome.storage.local.set({ notes: '', transcript: '', segments: [], notesCursor: 0, meetingContext: { topic: '', subjects: [], purpose: '' } }); });

async function companion(path, body) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type: 'companion', path, body });
  if (result.error) throw new Error(result.error);
  return result.data;
}
function option(value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
async function refreshConnection() {
  try {
    const status = await companion('/status');
    companionAvailable = true; notesConnected = status.connected; connectionControls();
    const selectedAccount = $('account').value;
    $('account').replaceChildren(option('', 'Add an account'));
    for (const account of status.accounts) $('account').append(option(account.clientId, `${account.label} · ${account.clientId.slice(-6)}`));
    if (status.account) $('account').value = status.account.clientId;
    else $('account').value = selectedAccount;
    $('model').replaceChildren(option('', 'Choose a notes model'));

    if (status.connected) {
      const catalog = await companion('/models');
      for (const model of catalog.models) $('model').append(option(model.id, model.name));
      if (status.model) $('model').value = status.model;
      $('connection-status').textContent = `Connected: ${status.account.label}`;
    } else $('connection-status').textContent = 'Helper connected. Continue with ChatGPT to authorize notes.';
    if (status.authError) $('connection-status').textContent = status.authError;
  } catch (error) {
    $('connection-status').textContent = error.message;
    companionAvailable = false; notesConnected = false; connectionControls();
  }
}
$('connect').addEventListener('click', async () => {
  const code = $('pairing').value.trim();
  if (!code) { $('connection-status').textContent = 'Paste the pairing code shown by the companion.'; return; }
  await chrome.storage.session.set({ pairingCode: code }); $('pairing').value = ''; await refreshConnection();
});
chrome.runtime.onMessage.addListener(message => {
  if (message.target !== 'panel' || message.type !== 'helper-disconnected') return;
  companionAvailable = false; notesConnected = false; connectionControls();
  $('model').replaceChildren(option('', 'Choose after signing in'));
  $('connection-status').textContent = 'Local helper disconnected. Refresh connection and sign in again.';
});
$('refresh-connection').addEventListener('click', refreshConnection);
$('signin').addEventListener('click', async () => {
  try {
    const result = await companion('/signin', { clientId: $('account').value });
    const url = new URL(result.url);
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error('Invalid sign-in destination.');
    await chrome.tabs.create({ url: url.href });
    $('connection-status').textContent = 'Complete sign-in in the new tab, then click Refresh connection.';
  } catch (error) { $('connection-status').textContent = error.message; }
});
$('signout').addEventListener('click', async () => {
  try {
    const result = await companion('/signout', {}); await refreshConnection();
    if (!result.revoked) $('connection-status').textContent = 'Signed out locally. Remote revocation was not confirmed; disconnect Meeting Notes in ChatGPT Settings.';
  } catch (error) { $('connection-status').textContent = error.message; }
});
$('model').addEventListener('change', async () => {
  try { await companion('/model', { model: $('model').value }); $('connection-status').textContent = 'Notes connection ready.'; }
  catch (error) { $('connection-status').textContent = error.message; }
});
await refreshConnection();
