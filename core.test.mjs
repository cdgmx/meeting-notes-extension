import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OrderedQueue, readNotes } from './core.mjs';

test('batches run in order and overflow is explicit', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const queue = new OrderedQueue(2, async item => { seen.push(item); if (item === 1) await gate; });
  queue.add(1); queue.add(2);
  assert.throws(() => queue.add(3), /buffer/i);
  release(); await queue.drain();
  assert.deepEqual(seen, [1, 2]);
});

test('a completed streamed response returns notes; truncated streams fail', () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"Decisions"}\n\n';
  const completed = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  assert.equal(readNotes(delta + completed), 'Decisions');
  assert.throws(() => readNotes(delta), /incomplete/i);
  assert.throws(() => readNotes(delta + 'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n'), /incomplete/i);
  assert.throws(() => readNotes(delta + 'data: {"type":"response.completed"}\n\n'), /incomplete/i);
});

test('provider failure rejects drain and prevents further batches', async () => {
  const queue = new OrderedQueue(3, async () => { throw new Error('Provider unavailable'); });
  queue.add('audio');
  await assert.rejects(queue.drain(), /Provider unavailable/);
  assert.throws(() => queue.add('later audio'), /Provider unavailable/);
});

test('later context revises recent transcript segments without changing original audio transcription', async () => {
  const { applyCorrections } = await import('./core.mjs');
  const original = [{ raw: 'We met Jen', corrected: 'We met Jen' }, { raw: 'at Acme Corp', corrected: 'at Acme Corp' }];
  const result = applyCorrections(original, ['We met Jan', 'at Acme Corp']);
  assert.deepEqual(result, [{ raw: 'We met Jen', corrected: 'We met Jan' }, { raw: 'at Acme Corp', corrected: 'at Acme Corp' }]);
  assert.equal(original[0].corrected, 'We met Jen');
  assert.throws(() => applyCorrections(original, ['We met Jan']), /segment/i);
  assert.throws(() => applyCorrections(original, ['', 'at Acme Corp']), /segment/i);
});
