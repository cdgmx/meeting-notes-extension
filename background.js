// Use the action event so the toolbar click grants activeTab before opening the panel.
// Reset the automatic opening behavior persisted by previous versions.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(error => {
  console.error('Could not enable the Meeting Notes side panel:', error);
});
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(error => {
    console.error('Could not open the Meeting Notes side panel:', error);
  });
});
let starting = false;

let nativePort; let nativePairing; let nativeConnecting;
async function automaticPairing() {
  if (nativePairing) return nativePairing;
  if (nativeConnecting) return nativeConnecting;
  nativeConnecting = new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('com.meeting_notes.helper');
    nativePort = port;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; port.disconnect(); reject(new Error('Local helper did not respond.')); } }, 10000);
    port.onMessage.addListener(message => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (typeof message.pairingCode !== 'string' || !message.pairingCode) { port.disconnect(); reject(new Error('Invalid helper response.')); return; }
      nativePairing = message.pairingCode; resolve(nativePairing);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const wasConnected = Boolean(nativePairing);
      nativePort = undefined; nativePairing = undefined;
      if (wasConnected) void chrome.runtime.sendMessage({ target: 'panel', type: 'helper-disconnected' }).catch(() => {});
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Local helper unavailable. Install the helper and try again.')); }
    });
    port.postMessage({ type: 'connect' });
  });
  try { return await nativeConnecting; } finally { nativeConnecting = undefined; }
}

async function helperPairing() {
  try { return await automaticPairing(); }
  catch (error) {
    const saved = await chrome.storage.session.get('pairingCode');
    if (typeof saved.pairingCode === 'string' && saved.pairingCode) return saved.pairingCode;
    throw error;
  }
}

async function companionRequest(path, body) {
  const pairingCode = await helperPairing();
  // Chrome attaches Origin to POST; privileged extension GET requests can omit it.
  let payload = body;
  if (payload === undefined) payload = {};
  const options = { method: 'POST', headers: { Authorization: `Bearer ${pairingCode}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(25000) };
  let response;
  try { response = await fetch(`http://127.0.0.1:1455${path}`, options); }
  catch { throw new Error('Local helper is unavailable. Check the helper or manual recovery setup.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'background') return;
  if (message.type === 'notes-connection') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) {
      reply({ error: 'Notes connection is restricted to the capture document.' }); return;
    }
    helperPairing().then(pairingCode => reply({ pairingCode }), error => reply({ error: error.message }));
    return true;
  }
  if (message.type === 'companion') {
    void (async () => {
      try {
        if (!['/status', '/models', '/signin', '/signout', '/model'].includes(message.path)) throw new Error('Unknown companion request.');
        const data = await companionRequest(message.path, message.body);
        reply({ data });
      } catch (error) { reply({ error: error.message }); }
    })();
    return true;
  }
  if (message.type === 'read-state') {
    chrome.storage.local.get(['transcript', 'segments', 'notes', 'prompt', 'notesCursor', 'meetingContext']).then(
      data => reply({ data }), error => reply({ error: error.message })
    );
    return true;
  }
  if (message.type === 'write-state') {
    chrome.storage.local.set(message.patch).then(
      () => reply({ ok: true }), error => reply({ error: error.message })
    );
    return true;
  }
  if (message.type === 'start') {
    void (async () => {
      if (starting) { reply({ error: 'Capture is already starting.' }); return; }
      starting = true;
      try {
        const tab = await chrome.tabs.get(message.tabId);
        // Chrome may omit the URL when this tab has not granted access yet.
        if (typeof tab.url === 'string' && /^(chrome|chrome-untrusted|chrome-extension|devtools|about):/.test(tab.url)) {
          throw new Error('Chrome pages cannot be recorded. Switch to a meeting or video webpage.');
        }
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Capture and process audio from the selected tab.' });
        const connection = await chrome.runtime.sendMessage({ target: 'capture', type: 'check' });
        if (connection.error) throw new Error(connection.error);
        let streamId;
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId });
        } catch (error) {
          if (error.message.includes('Extension has not been invoked')) {
            throw new Error('Tab access needed. Click Meeting Notes in the Chrome toolbar, then try again.');
          }
          throw error;
        }
        const result = await chrome.runtime.sendMessage({ target: 'capture', type: 'start', streamId });
        reply(result);
      } catch (error) { reply({ error: error.message }); }
      finally { starting = false; }
    })();
    return true;
  }
});
