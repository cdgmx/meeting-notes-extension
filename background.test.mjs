import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./background.js', import.meta.url), 'utf8');

function nativePort(pairingCode) {
  let callback;
  return { onMessage: { addListener(fn) { callback = fn; } }, onDisconnect: { addListener() {} }, postMessage() { queueMicrotask(() => callback({ pairingCode })); } };
}


async function startCapture(url, captureError) {
  let listener;
  const messages = [];
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    tabs: { get: async () => ({ id: 7, url }) },
    runtime: {
      onMessage: { addListener: callback => { listener = callback; } },
      getContexts: async () => [{}],
      sendMessage: async message => { messages.push(message); return { ok: true }; }
    },
    tabCapture: {
      getMediaStreamId: async options => {
        assert.equal(options.targetTabId, 7);
        if (captureError) throw new Error(captureError);
        return 'stream-7';
      }
    }
  };
  runInNewContext(source, { chrome, console });
  const result = await new Promise(resolve => {
    assert.equal(listener({ target: 'background', type: 'start', tabId: 7 }, {}, resolve), true);
  });
  return { result, messages };
}

test('missing tab access explains how to activate it and retry', async () => {
  const { result, messages } = await startCapture(undefined, 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.');
  assert.equal(result.error, 'Tab access needed. Click Meeting Notes in the Chrome toolbar, then try again.');
  assert.equal(messages.some(message => message.type === 'start'), false);
});

test('toolbar action opens the panel explicitly without starting capture', () => {
  let actionListener;
  const behaviors = [];
  const opened = [];
  const chrome = {
    sidePanel: {
      setPanelBehavior: async behavior => { behaviors.push(behavior); },
      open: async options => { opened.push(options); }
    },
    action: { onClicked: { addListener: callback => { actionListener = callback; } } },
    runtime: { onMessage: { addListener: () => {} } }
  };
  runInNewContext(source, { chrome, console });
  assert.equal(behaviors[0].openPanelOnActionClick, false);
  assert.equal(typeof actionListener, 'function');
  actionListener({ id: 7, windowId: 3 });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].windowId, 3);
});

test('restricted Chrome pages get instructions before contacting ChatGPT', async () => {
  const { result, messages } = await startCapture('chrome://extensions/');
  assert.match(result.error, /Chrome pages cannot be recorded/);
  assert.match(result.error, /meeting or video webpage/);
  assert.equal(messages.length, 0);
});

test('unrelated capture errors retain their actual cause', async () => {
  const { result } = await startCapture('https://example.com/meeting', 'Tab is already being captured.');
  assert.equal(result.error, 'Tab is already being captured.');
});

test('authorized capture still forwards the stream to the offscreen document', async () => {
  const { result, messages } = await startCapture('https://example.com/meeting');
  assert.equal(result.ok, true);
  assert.equal(messages.at(-1).type, 'start');
  assert.equal(messages.at(-1).streamId, 'stream-7');
});

test('worker persists offscreen state, reads note inputs, and reports storage failures', async () => {
  let listener;
  const saved = { prompt: 'Decisions only', notes: 'Previous notes' };
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    runtime: { onMessage: { addListener: callback => { listener = callback; } } },
    storage: { local: {
      set: async patch => { Object.assign(saved, patch); },
      get: async keys => {
        assert.deepEqual(Array.from(keys), ['transcript', 'segments', 'notes', 'prompt', 'notesCursor', 'meetingContext']);
        return saved;
      }
    } }
  };
  runInNewContext(source, { chrome, console });
  const send = message => new Promise(resolve => {
    assert.equal(listener({ target: 'background', ...message }, {}, resolve), true);
  });
  assert.equal((await send({ type: 'write-state', patch: { active: true, status: 'Listening' } })).ok, true);
  assert.equal(saved.active, true);
  assert.equal(saved.status, 'Listening');
  const result = await send({ type: 'read-state' });
  assert.equal(result.data.prompt, 'Decisions only');
  assert.equal(result.data.notes, 'Previous notes');
  chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  assert.equal((await send({ type: 'write-state', patch: { active: false } })).error, 'Storage unavailable');
});

test('companion bridge uses POST for reads so Chrome supplies its extension Origin', async () => {
  let listener;
  const requests = [];
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(callback) { listener = callback; } }, connectNative() { return nativePort('paired-code'); } }
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ connected: false, models: [] });
  };
  runInNewContext(source, { chrome, console, fetch, AbortSignal, setTimeout, clearTimeout });
  for (const path of ['/status', '/models']) {
    const result = await new Promise(resolve => listener({ target: 'background', type: 'companion', path }, {}, resolve));
    assert.equal(result.error, undefined);
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer paired-code');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), {});
    assert.equal(request.options.headers.Origin, undefined, 'browser owns the Origin header');
  }
});

test('pairing is returned only to the extension capture document and notes cannot run in the worker', async () => {
  let listener;
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} }, action: { onClicked: { addListener() {} } },
    runtime: { id: 'extension-id', getURL: path => 'chrome-extension://extension-id/' + path, onMessage: { addListener(callback) { listener = callback; } }, connectNative() { return nativePort('paired-code'); } }
  };
  runInNewContext(source, { chrome, console, setTimeout, clearTimeout });
  const send = (message, sender) => new Promise(resolve => listener({ target: 'background', ...message }, sender, resolve));
  for (const sender of [{ id: 'other', url: chrome.runtime.getURL('offscreen.html') }, { id: chrome.runtime.id, url: 'https://example.com' }]) {
    const rejected = await send({ type: 'notes-connection' }, sender);
    assert.match(rejected.error, /restricted/); assert.equal(rejected.pairingCode, undefined);
  }
  const accepted = await send({ type: 'notes-connection' }, { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') });
  assert.equal(accepted.pairingCode, 'paired-code');
  const notes = await send({ type: 'companion', path: '/notes', body: {} }, {});
  assert.equal(notes.error, 'Unknown companion request.');
});

test('automatically connects the authorized native helper and clears a disconnected pairing', async () => {
  let listener; let receive; let disconnect; let starts = 0; const sent = [];
  const port = { onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { disconnect = fn; } }, postMessage(value) { sent.push(value); queueMicrotask(() => receive({ pairingCode: 'native-secret' })); } };
  const chrome = { sidePanel: { setPanelBehavior: async () => {} }, action: { onClicked: { addListener() {} } }, runtime: { id: 'id', getURL: path => 'chrome-extension://id/' + path, onMessage: { addListener(fn) { listener = fn; } }, connectNative(name) { assert.equal(name, 'com.meeting_notes.helper'); starts++; return port; }, sendMessage: async () => {} } };
  const fetch = async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer native-secret'); return Response.json({ connected: false }); };
  runInNewContext(source, { chrome, console, fetch, AbortSignal, setTimeout, clearTimeout });
  const request = () => new Promise(resolve => listener({ target: 'background', type: 'companion', path: '/status' }, {}, resolve));
  assert.equal((await request()).data.connected, false); assert.equal(starts, 1); assert.equal(sent[0].type, 'connect');
  disconnect(); assert.equal((await request()).data.connected, false); assert.equal(starts, 2);
});

test('manual recovery uses saved pairing when automatic native host is unavailable', async () => {
  let listener;
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} }, action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, connectNative() { throw new Error('Host missing'); } },
    storage: { session: { get: async () => ({ pairingCode: 'manual-secret' }) } }
  };
  const fetch = async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer manual-secret'); return Response.json({ connected: false }); };
  runInNewContext(source, { chrome, console, fetch, AbortSignal, setTimeout, clearTimeout });
  const result = await new Promise(resolve => listener({ target: 'background', type: 'companion', path: '/status' }, {}, resolve));
  assert.equal(result.data.connected, false);
});

test('native disconnect tells the panel to clear its connected state', async () => {
  let listener; let receive; let disconnected; const notifications = [];
  const port = { onMessage: { addListener(fn) { receive = fn; } }, onDisconnect: { addListener(fn) { disconnected = fn; } }, postMessage() { queueMicrotask(() => receive({ pairingCode: 'secret' })); } };
  const chrome = { sidePanel: { setPanelBehavior: async () => {} }, action: { onClicked: { addListener() {} } }, runtime: { onMessage: { addListener(fn) { listener = fn; } }, connectNative() { return port; }, sendMessage: async message => { notifications.push(message); } }, storage: { session: { get: async () => ({}) } } };
  runInNewContext(source, { chrome, console, AbortSignal, setTimeout, clearTimeout, fetch: async () => Response.json({ connected: true }) });
  await new Promise(resolve => listener({ target: 'background', type: 'companion', path: '/status' }, {}, resolve));
  disconnected();
  assert.equal(notifications.length, 1); assert.equal(notifications[0].type, 'helper-disconnected');
});
