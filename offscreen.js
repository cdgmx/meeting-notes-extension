import { OrderedQueue, wav, applyCorrections, CorrectionError } from './core.mjs';

let stream; let context; let processor; let samples = []; let count = 0; let queue; let notesWorker; let capturing = false; let stopping = false; let starting = false;
const batchSeconds = 5;
// Offscreen documents only expose chrome.runtime; the worker owns storage access.
const state = async patch => {
  const result = await chrome.runtime.sendMessage({ target: 'background', type: 'write-state', patch });
  if (result.error) throw new Error(result.error);
};

async function session() {
  const response = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`ChatGPT session unavailable (${response.status}). Sign in to chatgpt.com and try again.`);
  const data = await response.json();
  if (typeof data.accessToken !== 'string') throw new Error('ChatGPT did not expose an access token to this extension. This experimental connection is unavailable.');
  let payload;
  try { const part = data.accessToken.split('.')[1]; payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { throw new Error('ChatGPT returned an unsupported session token.'); }
  const account = payload['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof account !== 'string' || !account) throw new Error('ChatGPT did not provide an account ID for this experimental connection.');
  return { token: data.accessToken, account };
}

async function checkedFetch(url, options, operation) {
  const response = await fetch(url, { ...options, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(90000) });
  if (!response.ok) {
    let detail = '';
    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const body = await response.json();
        const code = body.detail?.code;
        if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) detail = ` ${code}.`;
      } catch {
        // A malformed error body must not hide the HTTP failure.
      }
    }
    throw new Error(`${operation} failed (${response.status}).${detail}`);
  }
  return response;
}

// Serialize only short storage transactions, never provider requests.
let storageTail = Promise.resolve();
function withStorage(operation) {
  const result = storageTail.then(operation);
  storageTail = result.catch(() => {});
  return result;
}
async function readState() {
  const result = await chrome.runtime.sendMessage({ target: 'background', type: 'read-state' });
  if (result.error) throw new Error(result.error);
  return result.data;
}
function savedSegments(saved) {
  if (saved.segments !== undefined) return saved.segments;
  if (saved.transcript) return [{ raw: saved.transcript, corrected: saved.transcript }];
  return [];
}

function parseMeetingContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.topic !== 'string' || value.topic.length > 160) return undefined;
  if (typeof value.purpose !== 'string' || value.purpose.length > 160) return undefined;
  if (!Array.isArray(value.subjects) || value.subjects.length > 8) return undefined;
  if (value.subjects.some(subject => typeof subject !== 'string' || subject.length > 80)) return undefined;
  return { topic: value.topic, subjects: value.subjects.slice(), purpose: value.purpose };
}

export function createNotesWorker(onError) {
  let cursor; let target = 0; let running; let failure;
  async function update() {
    while (true) {
      const snapshot = await withStorage(async () => {
        const saved = await readState(); const segments = savedSegments(saved);
        if (cursor === undefined) {
          if (saved.notesCursor === undefined) cursor = 0;
          else if (Number.isInteger(saved.notesCursor) && saved.notesCursor >= 0 && saved.notesCursor <= segments.length) cursor = saved.notesCursor;
          else throw new Error('Saved notes progress is invalid. Transcript is saved.');
        }
        if (cursor >= target) return undefined;
        const end = Math.min(cursor + 5, target, segments.length);
        if (end <= cursor) throw new Error('Transcript changed before notes could be updated.');
        const start = Math.max(0, cursor - 5);
        let instructions = saved.prompt;
        if (instructions === undefined) instructions = 'Create concise meeting notes with key points, decisions, and action items. Do not invent details.';
        if (!instructions.trim()) throw new Error('Add a note-taking prompt before continuing.');
        let existingNotes = saved.notes;
        if (existingNotes === undefined) existingNotes = '';
        let meetingContext;
        if (saved.meetingContext === undefined) meetingContext = { topic: '', subjects: [], purpose: '' };
        else {
          meetingContext = parseMeetingContext(saved.meetingContext);
          if (!meetingContext) throw new Error('Saved meeting context is invalid. Transcript is saved.');
        }
        return { start, end, contextEnd: cursor - start, recent: segments.slice(start, end), instructions, existingNotes, meetingContext };

      });
      if (!snapshot) return;
      const body = {
        instructions: 'Return only JSON with corrections, notesDelta, and meetingContext. meetingContext must be an object with topic and purpose strings (maximum 160 characters each) and a subjects array (maximum 8 strings of 80 characters each). Infer these solely from supplied transcript and earlier transcript-derived meetingContext, never from notes; use empty strings or an empty array when unknown, and revise tentative context only when speech supports it. Use this context to improve recent transcription corrections without inventing words or changing meaning. corrections is an array of strings for contextSegments followed by newSegments, preserving their order and count. Correct transcription mistakes only when supported by context; preserve all spoken meaning. When uncertain, leave the original wording. notesDelta is only additional notes supported by newSegments; use contextSegments and existingNotes only for context, never rewrite or repeat existing notes. Return an empty notesDelta if there is nothing new. Include a leading newline for a new entry, or a leading space to continue the last line; do not include a leading separator when existingNotes is empty. Follow the note-taking instructions.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ noteInstructions: snapshot.instructions, existingNotes: snapshot.existingNotes, meetingContext: snapshot.meetingContext, contextSegments: snapshot.recent.slice(0, snapshot.contextEnd), newSegments: snapshot.recent.slice(snapshot.contextEnd) }) }] }]
      };
      let answer;
      try {
        const connection = await chrome.runtime.sendMessage({ target: 'background', type: 'notes-connection' });
        if (connection.error) throw new Error(connection.error);
        const response = await fetch('http://127.0.0.1:1455/notes', {
          method: 'POST', headers: { Authorization: `Bearer ${connection.pairingCode}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(95000)
        });
        answer = await response.json();
        if (!response.ok) throw new Error(answer.error);
      } catch (error) { throw new Error(`Note generation: ${error.message} Transcript is saved.`); }
      let result;
      try { result = JSON.parse(answer.text); }
      catch { throw new Error('Transcript correction response was invalid; original transcription is saved.'); }
      if (typeof result.notesDelta !== 'string') throw new Error('Notes response was invalid; original transcription is saved.');
      const nextContext = parseMeetingContext(result.meetingContext);
      let corrected;
      try { corrected = applyCorrections(snapshot.recent, result.corrections); }
      catch (error) { if (!(error instanceof CorrectionError)) throw error; }
      await withStorage(async () => {
        const saved = await readState(); const segments = savedSegments(saved);
        let currentNotes = saved.notes;
        if (currentNotes === undefined) currentNotes = '';
        if (currentNotes !== snapshot.existingNotes) throw new Error('Notes changed during update. Existing notes and transcript are saved.');
        const updatedNotes = currentNotes + result.notesDelta;
        let matches = segments.length >= snapshot.end;
        for (let i = 0; i < snapshot.recent.length && matches; i++) {
          const current = segments[snapshot.start + i]; const previous = snapshot.recent[i];
          if (current.raw !== previous.raw || current.corrected !== previous.corrected) matches = false;
        }
        const patch = { notes: updatedNotes, notesCursor: snapshot.end };
        const warnings = [];
        if (nextContext) patch.meetingContext = nextContext;
        else warnings.push('Meeting context was not updated because the response was invalid.');
        if (!corrected || !matches) warnings.push('Transcript correction was skipped because the response was invalid or the transcript changed.');
        else {
          const firstEditable = Math.max(0, segments.length - 5);
          for (let i = 0; i < corrected.length; i++) {
            const index = snapshot.start + i;
            if (index >= firstEditable) segments[index] = corrected[i];
          }
          patch.segments = segments;
          patch.transcript = segments.map(segment => segment.corrected).join('\n\n');
        }
        if (warnings.length) {
          patch.status = 'Notes updated. ' + warnings.join(' ');
          patch.statusError = false;
        }
        await state(patch);
      });
      cursor = snapshot.end;
    }
  }
  function startWork() {
    if (running || failure) return;
    running = update().catch(error => { failure = error; onError(error); }).finally(() => { running = undefined; if (!failure && cursor < target) startWork(); });
  }
  return {
    notify(end) {
      target = Math.max(target, end);
      startWork();
    },
    async resume() {
      const end = await withStorage(async () => savedSegments(await readState()).length);
      target = Math.max(target, end);
      startWork();
    },
    async drain() {
      while (running) await running;
      if (failure) throw failure;
    }
  };
}

export async function processBatch(batch, notesWorker) {
  const auth = await session();
  const headers = { Authorization: `Bearer ${auth.token}`, 'ChatGPT-Account-Id': auth.account, originator: 'Meeting Notes' };
  const form = new FormData(); form.append('file', wav(batch.samples, batch.rate), 'meeting.wav');
  const response = await checkedFetch('https://chatgpt.com/backend-api/transcribe', { method: 'POST', headers, body: form }, 'Transcription');
  const transcription = await response.json();
  if (typeof transcription.text !== 'string') throw new Error('Transcription response did not contain text.');
  const text = transcription.text.trim();
  if (!text) return;
  const index = await withStorage(async () => {
    const saved = await readState(); const segments = savedSegments(saved); const index = segments.length;
    segments.push({ raw: text, corrected: text });
    await state({ segments, transcript: segments.map(segment => segment.corrected).join('\n\n') });
    return index;
  });
  notesWorker.notify(index + 1);
}

async function stop(reason, flushPartial = false, failure = false) {
  if (stopping) return;
  stopping = true; capturing = false;
  let statusError = Boolean(reason && (!flushPartial || failure));
  if (processor) processor.disconnect();
  if (stream) for (const track of stream.getTracks()) track.stop();
  if (context) await context.close();
  if (count && (!reason || flushPartial)) {
    try { queue.add({ samples: combine(), rate: context.sampleRate }); }
    catch (error) { reason = `${error.message} Some captured audio was not processed and was discarded.`; statusError = true; }
  }
  samples = []; count = 0;
  let message = 'Finishing transcription…';
  if (reason) message = reason;
  await state({ status: message, statusError, active: false, busy: true });
  try { if (queue) await queue.drain(); }
  catch (error) { reason = `${error.message} Some captured audio was not processed and was discarded.`; statusError = true; }
  try { if (notesWorker) await notesWorker.drain(); }
  catch (error) {
    if (!reason) reason = error.message;
    else if (!reason.includes(error.message)) reason += ` ${error.message}`;
    statusError = true;
  }
  message = 'Stopped. Notes are saved on this device.';
  if (reason) message = reason;
  await state({ status: message, statusError, active: false, busy: false });
  stream = undefined; context = undefined; processor = undefined; queue = undefined; notesWorker = undefined; stopping = false;
}
function combine() { const all = new Float32Array(count); let offset = 0; for (const block of samples) { all.set(block, offset); offset += block.length; } samples = []; count = 0; return all; }
async function start(streamId) {
  if (capturing || stopping || starting) throw new Error('A capture is already active or finishing.');
  starting = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
    context = new AudioContext(); const source = context.createMediaStreamSource(stream); source.connect(context.destination);
    processor = context.createScriptProcessor(4096, 1, 1); source.connect(processor); processor.connect(context.destination);
    notesWorker = createNotesWorker(error => { void stop(error.message, true, true); });
    queue = new OrderedQueue(3, async batch => { try { await processBatch(batch, notesWorker); } catch (error) { void stop(`${error.message} Some captured audio was not processed and was discarded.`); throw error; } });
    capturing = true; stream.getAudioTracks()[0].onended = () => { if (capturing) void stop('Tab capture ended. Final audio was processed if possible.', true); };
    processor.onaudioprocess = event => {
      if (!capturing) return;
      const block = new Float32Array(event.inputBuffer.getChannelData(0)); samples.push(block); count += block.length;
      if (count >= context.sampleRate * batchSeconds) {
        try { queue.add({ samples: combine(), rate: context.sampleRate }); }
        catch (error) { void stop(`${error.message} Some captured audio was not processed and was discarded.`); }
      }
    };
    await state({ active: true, busy: true, status: 'Listening to this tab. Audio is sent to ChatGPT in batches.', statusError: false });
    await notesWorker.resume();
  } catch (error) { await stop(error.message); throw error; }
  finally { starting = false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'capture') return;
  if (message.type === 'check') { session().then(() => reply({ ok: true }), error => reply({ error: error.message })); return true; }
  if (message.type === 'start') { start(message.streamId).then(() => reply({ ok: true }), error => reply({ error: error.message })); return true; }
  if (message.type === 'stop') { stop().then(() => reply({ ok: true }), error => reply({ error: error.message })); return true; }
});
