// Chrome native messaging: four-byte little-endian length followed by UTF-8 JSON.
export function nativeConnection(input, output, pairingCode, close) {
  let buffer = Buffer.alloc(0); let ended = false;
  const stop = () => { if (ended) return; ended = true; void close(); };
  input.on('data', chunk => {
    if (ended) return;
    if (buffer.length + chunk.length > 4100) { stop(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const size = buffer.readUInt32LE(0);
    if (size > 4096) { stop(); return; }
    if (buffer.length < size + 4) return;
    try {
      const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
      if (message.type !== 'connect' || buffer.length !== size + 4) throw new Error('Invalid message');
      const payload = Buffer.from(JSON.stringify({ pairingCode }));
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      output.write(Buffer.concat([header, payload])); buffer = Buffer.alloc(0);
    } catch { stop(); }
  });
  input.once('end', stop); input.once('error', stop); output.once('error', stop);
}
