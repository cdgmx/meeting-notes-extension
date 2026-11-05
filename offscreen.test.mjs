import { test } from 'node:test';
import { strict as assert } from 'node:assert';

let captureListener;
globalThis.chrome = { runtime: { onMessage: { addListener(fn) { captureListener = fn; } }, async sendMessage() {} } };
const { processBatch, createNotesWorker } = await import('./offscreen.js');
async function processComplete(batch) { const worker = createNotesWorker(() => {}); await processBatch(batch, worker); await worker.drain(); }
const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.test`;
const batch = { samples: new Float32Array(16000), rate: 16000 };

test('web transcription includes browser credentials and uploads a WAV file', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    assert.equal(url, 'https://chatgpt.com/backend-api/transcribe');
    assert.equal(options.credentials, 'include');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.body.get('file').type, 'audio/wav');
    assert.equal(options.body.get('file').size, 32044);
    return Response.json({ text: '' });
  });
  await processComplete(batch);
  assert.equal(requests.length, 2);
});

test('a rejected transcription identifies the failing operation', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    return Response.json({ detail: { code: 'token_expired' } }, { status: 401 });
  });
  await assert.rejects(processComplete(batch), /Transcription failed \(401\)/);
});

test('note authentication failure is distinct and preserves the received transcript', async t => {
  const saved = { prompt: 'List decisions' };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: saved };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    assert.equal(message.type, 'write-state');
    Object.assign(saved, message.patch);
    return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'We will meet on Friday.' });
    assert.equal(url, 'http://127.0.0.1:1455/notes');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer paired-code');
    return Response.json({ error: 'OpenAI request failed (401).' }, { status: 400 });
  });
  await assert.rejects(processComplete(batch), /Note generation: OpenAI request failed \(401\).*Transcript is saved/);
  assert.equal(saved.transcript, 'We will meet on Friday.');
  assert.deepEqual(saved.segments, [{ raw: 'We will meet on Friday.', corrected: 'We will meet on Friday.' }]);
  assert.equal(saved.notes, undefined);
});


test('completed OAuth notes update corrections while retaining original transcription', async t => {
  const saved = { prompt: 'List decisions' };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: saved };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, message.patch); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'http://127.0.0.1:1455/notes') {
      assert.equal(saved.transcript, 'Meet on fry day.');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer paired-code');
      assert.equal(JSON.parse(options.body).model, undefined);
      return Response.json({ text: JSON.stringify({ corrections: ['Meet on Friday.'], notesDelta: 'Meeting: Friday.' }) });
    }
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    assert.equal(url, 'https://chatgpt.com/backend-api/transcribe');
    return Response.json({ text: 'Meet on fry day.' });
  });
  await processComplete(batch);
  assert.equal(saved.transcript, 'Meet on Friday.');
  assert.equal(saved.segments[0].raw, 'Meet on fry day.');
  assert.equal(saved.notes, 'Meeting: Friday.');
});

test('invalid correction count keeps existing text, saves notes and continues to next batch', async t => {
  const saved = { prompt: 'List decisions', segments: [{ raw: 'Previous raw.', corrected: 'Previous corrected.' }], notes: 'Earlier notes.' };
  let notesRequests = 0;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: saved };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, message.patch); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'New raw.' });
    notesRequests++;
    if (notesRequests === 1) return Response.json({ text: JSON.stringify({ corrections: ['wrong count'], notesDelta: '\nNew notes.' }) });
    return Response.json({ text: JSON.stringify({ corrections: ['Previous corrected.', 'New raw.', 'New corrected.'], notesDelta: '\nFinal notes.' }) });
  });
  await processComplete(batch);
  assert.equal(saved.transcript, 'Previous corrected.\n\nNew raw.'); assert.equal(saved.notes, 'Earlier notes.\nNew notes.');
  assert.deepEqual(saved.segments, [{ raw: 'Previous raw.', corrected: 'Previous corrected.' }, { raw: 'New raw.', corrected: 'New raw.' }]);
  assert.match(saved.status, /correction.*skipped/i);
  await processComplete(batch);
  assert.equal(saved.notes, 'Earlier notes.\nNew notes.\nFinal notes.'); assert.equal(saved.transcript, 'Previous corrected.\n\nNew raw.\n\nNew corrected.');
  assert.equal(saved.segments[2].raw, 'New raw.');
});

test('invalid correction entries are skipped while invalid notes remain an error', async t => {
  const saved = { prompt: 'Decisions' }; let notes = 'Notes saved.';
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: saved };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, message.patch); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'Original.' });
    return Response.json({ text: JSON.stringify({ corrections: saved.segments.map(() => ''), notesDelta: notes }) });
  });
  await processComplete(batch);
  assert.equal(saved.transcript, 'Original.'); assert.equal(saved.notes, 'Notes saved.'); assert.match(saved.status, /correction.*skipped/i);
  notes = null;
  await assert.rejects(processComplete(batch), /Notes response was invalid/);
  assert.equal(saved.notes, 'Notes saved.'); assert.equal(saved.transcript, 'Original.\n\nOriginal.');
});


test('capture startup errors persist explicit error severity', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { throw new Error('No audio device found.'); } } } });
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; });
  const patches = [];
  t.mock.method(chrome.runtime, 'sendMessage', async message => { patches.push(message.patch); return { ok: true }; });
  const result = await new Promise(resolve => captureListener({ target: 'capture', type: 'start', streamId: 'stream' }, {}, resolve));
  assert.equal(result.error, 'No audio device found.');
  const last = patches.at(-1); assert.equal(last.status, 'No audio device found.'); assert.equal(last.statusError, true);
  await new Promise(resolve => captureListener({ target: 'capture', type: 'stop' }, {}, resolve));
  assert.equal(patches.at(-1).statusError, false); assert.match(patches.at(-1).status, /Stopped/);
});

test('transcription proceeds while notes wait and late corrections preserve newer segments', async t => {
  const { createNotesWorker } = await import('./offscreen.js');
  let releaseNotes; const gate = new Promise(resolve => { releaseNotes = resolve; });
  let firstStarted; const noteStarted = new Promise(resolve => { firstStarted = resolve; });
  const saved = { prompt: 'Decisions' }; let transcriptions = 0; let noteCount = 0;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) { transcriptions++; return Response.json({ text: `segment ${transcriptions}` }); }
    noteCount++; const payload = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    if (noteCount === 1) { firstStarted(); await gate; }
    return Response.json({ text: JSON.stringify({ notesDelta: `notes ${noteCount}`, corrections: [...payload.contextSegments, ...payload.newSegments].map(segment => segment.corrected.toUpperCase()) }) });
  });
  const worker = createNotesWorker(() => {});
  await processBatch(batch, worker); await noteStarted;
  await processBatch(batch, worker); await processBatch(batch, worker);
  assert.equal(saved.transcript, 'segment 1\n\nsegment 2\n\nsegment 3');
  assert.equal(noteCount, 1);
  releaseNotes(); await worker.drain();
  assert.equal(saved.transcript, 'SEGMENT 1\n\nSEGMENT 2\n\nSEGMENT 3');
  assert.equal(saved.notes, 'notes 1notes 2'); assert.equal(noteCount, 2);
});

test('coalesced notes cover every segment in bounded groups', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const firstStarted = new Promise(resolve => { started = resolve; });
  let index = 0; const covered = new Set(); const counts = []; const saved = { prompt: 'Decisions' };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) { index++; return Response.json({ text: `segment ${index}` }); }
    const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    counts.push([...input.contextSegments, ...input.newSegments].length); for (const segment of [...input.contextSegments, ...input.newSegments]) covered.add(segment.raw);
    if (counts.length === 1) { started(); await gate; }
    return Response.json({ text: JSON.stringify({ notesDelta: 'Updated notes', corrections: [...input.contextSegments, ...input.newSegments].map(segment => segment.corrected) }) });
  });
  const worker = createNotesWorker(() => {});
  await processBatch(batch, worker); await firstStarted;
  for (let i = 0; i < 11; i++) await processBatch(batch, worker);
  assert.equal(counts.length, 1); release(); await worker.drain();
  assert.equal(covered.size, 12); assert.equal(counts.length, 4); assert.ok(counts.every(count => count <= 10));
  assert.equal(saved.segments.length, 12);
});

test('late corrections skip changed prior segments without overwriting new text or notes', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const firstStarted = new Promise(resolve => { started = resolve; });
  const saved = { prompt: 'Decisions' };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'Original' });
    started(); await gate; return Response.json({ text: JSON.stringify({ notesDelta: 'New notes', corrections: ['Replacement'] }) });
  });
  const worker = createNotesWorker(() => {}); await processBatch(batch, worker); await firstStarted;
  saved.segments[0].corrected = 'Edited independently'; saved.transcript = 'Edited independently';
  release(); await worker.drain();
  assert.equal(saved.transcript, 'Edited independently'); assert.equal(saved.notes, 'New notes');
  assert.match(saved.status, /correction.*skipped/i);
});

test('notes failure is explicit after transcription and leaves transcript saved', async t => {
  const saved = { prompt: 'Decisions' }; let reported;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'Kept' });
    return Response.json({ error: 'Service unavailable' }, { status: 503 });
  });
  const worker = createNotesWorker(error => { reported = error; });
  await processBatch(batch, worker); await assert.rejects(worker.drain(), /Service unavailable/);
  assert.match(reported.message, /Transcript is saved/); assert.equal(saved.transcript, 'Kept');
});

test('stop flushes final partial batch and waits for note completion', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let processor; let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const notesStarted = new Promise(resolve => { started = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{}] }) } } });
  globalThis.AudioContext = class { constructor() { this.sampleRate = 1; this.destination = {}; } createMediaStreamSource() { return { connect() {} }; } createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; } async close() {} };
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; if (oldAudioContext) Object.defineProperty(globalThis, 'AudioContext', oldAudioContext); else delete globalThis.AudioContext; });
  const saved = { prompt: 'Decisions' };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'Final partial audio' });
    started(); await gate; return Response.json({ text: JSON.stringify({ notesDelta: 'Final notes', corrections: ['Final partial audio'] }) });
  });
  const send = message => new Promise(resolve => captureListener({ target: 'capture', ...message }, {}, resolve));
  assert.equal((await send({ type: 'start', streamId: 'test' })).ok, true);
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0.1, 0.2]) } });
  let stopped = false; const completion = send({ type: 'stop' }).then(result => { stopped = true; return result; });
  await notesStarted; assert.equal(stopped, false); assert.equal(saved.transcript, 'Final partial audio');
  release(); assert.equal((await completion).ok, true); assert.equal(saved.notes, 'Final notes'); assert.equal(saved.busy, false);
});

test('notes failure stops capture and still flushes accepted audio', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); const oldAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let processor; let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const notesStarted = new Promise(resolve => { started = resolve; });
  let finished; const stopped = new Promise(resolve => { finished = resolve; });
  let second; const secondSaved = new Promise(resolve => { second = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{}] }) } } });
  globalThis.AudioContext = class { constructor() { this.sampleRate = 1; this.destination = {}; } createMediaStreamSource() { return { connect() {} }; } createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; } async close() {} };
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; if (oldAudioContext) Object.defineProperty(globalThis, 'AudioContext', oldAudioContext); else delete globalThis.AudioContext; });
  const saved = { prompt: 'Decisions' }; let batches = 0;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch));
    if (saved.segments?.length === 2) second();
    if (message.patch.busy === false) finished();
    return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) { batches++; return Response.json({ text: `Audio ${batches}` }); }
    started(); await gate; return Response.json({ error: 'Service unavailable' }, { status: 503 });
  });
  const send = message => new Promise(resolve => captureListener({ target: 'capture', ...message }, {}, resolve));
  assert.equal((await send({ type: 'start', streamId: 'test' })).ok, true);
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(5) } });
  await notesStarted;
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(5) } });
  await secondSaved;
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2) } });
  release(); await stopped;
  assert.equal(saved.transcript, 'Audio 1\n\nAudio 2\n\nAudio 3'); assert.equal(saved.statusError, true);
  assert.match(saved.status, /Service unavailable/); assert.doesNotMatch(saved.status, /discarded/);
});

test('restart summarizes every segment left behind by a failed notes request', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let begun;
  const started = new Promise(resolve => { begun = resolve; });
  const saved = { prompt: 'Decisions' }; const included = new Set(); let transcription = 0; let noteRequests = 0;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) { transcription++; return Response.json({ text: `segment ${transcription}` }); }
    noteRequests++; const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    if (noteRequests === 1) { begun(); await gate; return Response.json({ error: 'offline' }, { status: 503 }); }
    for (const segment of [...input.contextSegments, ...input.newSegments]) included.add(segment.raw);
    return Response.json({ text: JSON.stringify({ notesDelta: `notes ${noteRequests}`, corrections: [...input.contextSegments, ...input.newSegments].map(segment => segment.corrected) }) });
  });
  const first = createNotesWorker(() => {});
  await processBatch(batch, first); await started;
  for (let i = 0; i < 7; i++) await processBatch(batch, first);
  release(); await assert.rejects(first.drain(), /offline/);
  assert.equal(saved.segments.length, 8);
  const second = createNotesWorker(() => {}); await processBatch(batch, second); await second.drain();
  assert.equal(included.size, 9); assert.equal(saved.notesCursor, 9);
  assert.equal(saved.segments.length, 9);
});

test('resume conservatively includes legacy transcript without waiting for new audio', async t => {
  const saved = { prompt: 'Decisions', notes: 'Older notes', segments: Array.from({ length: 7 }, (_, i) => ({ raw: `old ${i}`, corrected: `old ${i}` })) }; const covered = new Set();
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1455/notes');
    const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    for (const segment of [...input.contextSegments, ...input.newSegments]) covered.add(segment.raw);
    return Response.json({ text: JSON.stringify({ notesDelta: 'Updated notes', corrections: [...input.contextSegments, ...input.newSegments].map(segment => segment.corrected) }) });
  });
  const worker = createNotesWorker(() => {}); await worker.resume(); await worker.drain();
  assert.equal(covered.size, 7); assert.equal(saved.notesCursor, 7);
});

test('invalid persisted notes progress fails explicitly without modifying transcript', async t => {
  const saved = { notesCursor: 2, segments: [{ raw: 'Kept', corrected: 'Kept' }] }; let reported;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    assert.equal(message.type, 'read-state'); return { data: structuredClone(saved) };
  });
  const worker = createNotesWorker(error => { reported = error; }); await worker.resume();
  await assert.rejects(worker.drain(), /notes progress is invalid/i); assert.equal(reported.message.includes('Transcript is saved'), true); assert.equal(saved.segments[0].raw, 'Kept');
});

test('notes update appends only new material while preserving existing notes exactly', async t => {
  const saved = { prompt: 'Decisions', notes: 'Decision: keep original.\n', notesCursor: 1, segments: [{ raw: 'Original context', corrected: 'Original context' }] };
  let input;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'New decision' });
    input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    return Response.json({ text: JSON.stringify({ notes: 'Rewritten old decision.', notesDelta: 'Next: new decision.\n', corrections: ['Original context', 'New decision'] }) });
  });
  const worker = createNotesWorker(() => {}); await processBatch(batch, worker); await worker.drain();
  assert.equal(saved.notes, 'Decision: keep original.\nNext: new decision.\n');
  assert.deepEqual(input.contextSegments.map(s => s.raw), ['Original context']);
  assert.deepEqual(input.newSegments.map(s => s.raw), ['New decision']); assert.equal(saved.notesCursor, 2);
});

test('empty note delta preserves existing notes and advances coverage', async t => {
  const saved = { notes: 'Already covered.\n', notesCursor: 0, segments: [{ raw: 'Already covered', corrected: 'Already covered' }] };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ text: JSON.stringify({ notesDelta: '', corrections: ['Already covered'] }) }));
  const worker = createNotesWorker(() => {}); await worker.resume(); await worker.drain();
  assert.equal(saved.notes, 'Already covered.\n'); assert.equal(saved.notesCursor, 1);
});

test('changed notes during an in-flight request remain intact and do not advance coverage', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let begun;
  const started = new Promise(resolve => { begun = resolve; });
  const saved = { notes: 'Old notes', notesCursor: 0, segments: [{ raw: 'New speech', corrected: 'New speech' }] };
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async () => { begun(); await gate; return Response.json({ text: JSON.stringify({ notesDelta: '\nNew detail', corrections: ['New speech'] }) }); });
  const worker = createNotesWorker(() => {}); await worker.resume(); await started;
  saved.notes = 'Changed independently'; release();
  await assert.rejects(worker.drain(), /Notes changed during update/);
  assert.equal(saved.notes, 'Changed independently'); assert.equal(saved.notesCursor, 0); assert.equal(saved.segments[0].raw, 'New speech');
});

test('derived context informs later updates and corrections never change segments older than latest five', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let begun;
  const started = new Promise(resolve => { begun = resolve; });
  const saved = { prompt: 'Decisions' }; let transcription = 0; let noteRequests = 0; let secondContext;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) { transcription++; return Response.json({ text: `word ${transcription}` }); }
    const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text); noteRequests++;
    if (noteRequests === 1) { begun(); await gate; }
    else secondContext = input.meetingContext;
    return Response.json({ text: JSON.stringify({ notesDelta: '', meetingContext: { topic: 'Project launch', subjects: ['budget'], purpose: 'Plan release' }, corrections: [...input.contextSegments, ...input.newSegments].map(s => s.corrected.toUpperCase()) }) });
  });
  const worker = createNotesWorker(() => {}); await processBatch(batch, worker); await started;
  for (let i = 0; i < 5; i++) await processBatch(batch, worker);
  release(); await worker.drain();
  assert.equal(saved.segments[0].raw, 'word 1'); assert.equal(saved.segments[0].corrected, 'word 1');
  assert.equal(saved.segments[5].corrected, 'WORD 6');
  assert.deepEqual(saved.meetingContext, { topic: 'Project launch', subjects: ['budget'], purpose: 'Plan release' });
  assert.deepEqual(secondContext, saved.meetingContext);
});

test('invalid meeting context is bounded, preserves prior context and reports the skipped update', async t => {
  const existing = { topic: 'Known topic', subjects: ['Budget'], purpose: '' };
  const saved = { prompt: 'Decisions', meetingContext: structuredClone(existing) }; let responses = 0;
  t.mock.method(chrome.runtime, 'sendMessage', async message => {
    if (message.type === 'read-state') return { data: structuredClone(saved) };
    if (message.type === 'notes-connection') return { pairingCode: 'paired-code' };
    Object.assign(saved, structuredClone(message.patch)); return { ok: true };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/api/auth/session')) return Response.json({ accessToken: token });
    if (url.endsWith('/transcribe')) return Response.json({ text: 'New speech' });
    const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text); responses++;
    assert.deepEqual(input.meetingContext, existing);
    const result = { notesDelta: 'New notes', corrections: [...input.contextSegments, ...input.newSegments].map(s => s.corrected) };
    if (responses === 1) result.meetingContext = { topic: 'x'.repeat(161), subjects: [], purpose: '' };
    return Response.json({ text: JSON.stringify(result) });
  });
  await processComplete(batch);
  assert.deepEqual(saved.meetingContext, existing); assert.match(saved.status, /context was not updated/i); assert.equal(saved.notes, 'New notes');
  await processComplete(batch);
  assert.deepEqual(saved.meetingContext, existing); assert.equal(saved.notesCursor, 2); assert.match(saved.status, /context was not updated/i);
});
