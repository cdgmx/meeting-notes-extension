export class OrderedQueue {
  constructor(limit, run) { this.limit = limit; this.run = run; this.pending = []; this.running = false; this.error = null; this.waiters = []; }
  add(item) {
    if (this.error) throw this.error;
    if (this.pending.length + Number(this.running) >= this.limit) throw new Error('Audio buffer is full; capture stopped.');
    this.pending.push(item); void this.work();
  }
  async work() {
    if (this.running) return;
    this.running = true;
    try { while (this.pending.length) await this.run(this.pending.shift()); }
    catch (error) { this.error = error; }
    finally { this.running = false; for (const waiter of this.waiters.splice(0)) waiter(); }
  }
  async drain() {
    if (this.running) await new Promise(resolve => this.waiters.push(resolve));
    if (this.error) throw this.error;
  }
}

export function readNotes(data) {
  let result = ''; let completed = false;
  for (const line of data.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const value = line.slice(6);
    if (value === '[DONE]') continue;
    const event = JSON.parse(value);
    if (event.type === 'response.output_text.delta') result += event.delta;
    if (event.type === 'response.completed' && event.response?.status === 'completed') completed = true;
    if (event.type === 'error' || event.type === 'response.failed') throw new Error('Notes provider rejected the request.');
  }
  if (!completed || !result.trim()) throw new Error('Notes response was incomplete.');
  return result.trim();
}

export function wav(samples, sampleRate) {
  const data = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(data);
  const put = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  put(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); let scaled = s * 32767; if (s < 0) scaled = s * 32768; view.setInt16(44 + i * 2, scaled, true); }
  return new Blob([data], { type: 'audio/wav' });
}

export class CorrectionError extends Error {}

export function applyCorrections(segments, corrections) {
  if (!Array.isArray(corrections) || corrections.length !== segments.length) throw new CorrectionError('Transcript correction has an invalid segment count.');
  return segments.map((segment, index) => {
    const corrected = corrections[index];
    if (typeof corrected !== 'string' || !corrected.trim()) throw new CorrectionError('Transcript correction contains an invalid segment.');
    return { raw: segment.raw, corrected: corrected.trim() };
  });
}
