const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { stlTo3mf, MODEL_PATH } = require('../mesh-copy.cjs');

function meshBuffer(faces) {
  const data = Buffer.alloc(84 + faces.length * 50);
  data.writeUInt32LE(faces.length, 80);
  faces.forEach((face, i) => face.flat().forEach((value, j) => data.writeFloatLE(value, 84 + i * 50 + 12 + j * 4)));
  return data;
}

function readPackage(zip) {
  const entries = {};
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const length = zip.readUInt16LE(offset + 26);
    const extra = zip.readUInt16LE(offset + 28);
    const name = zip.toString('utf8', offset + 30, offset + 30 + length);
    const start = offset + 30 + length + extra;
    const data = zlib.inflateRawSync(zip.subarray(start, start + size));
    assert.equal(data.length, zip.readUInt32LE(offset + 22));
    assert.equal(zlib.crc32(data), zip.readUInt32LE(offset + 14));
    entries[name] = data.toString('utf8');
    offset = start + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  return entries;
}

test('3MF round-trip preserves every ordered triangle coordinate, including float32 edge cases', () => {
  const faces = [[[0, -0, 0], [1.1234567, 0, 0], [0, 1, 1e-20]], [[0, -0, 0], [0, 1, 1e-20], [1.1234567, 0, 0]]];
  const source = meshBuffer(faces);
  const converted = stlTo3mf(source, 'part & "test"');
  const entries = readPackage(converted.data);
  assert.deepEqual(Object.keys(entries), ['[Content_Types].xml', '_rels/.rels', MODEL_PATH]);
  const xml = entries[MODEL_PATH];
  const vertices = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(match => match.slice(1).map(Number));
  const triangles = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].map(match => match.slice(1).map(Number));
  const rebuilt = Buffer.alloc(triangles.length * 36);
  triangles.forEach((triangle, i) => triangle.forEach((index, corner) => vertices[index].forEach((value, axis) => rebuilt.writeFloatLE(value, i * 36 + corner * 12 + axis * 4))));
  assert.equal(converted.triangles, faces.length);
  assert.equal(converted.vertices, 3);
  assert.equal(crypto.createHash('sha256').update(rebuilt).digest('hex'), converted.geometrySha256);
  assert.match(xml, /unit="millimeter"/);
  assert.match(xml, /part &amp; &quot;test&quot;/);
  assert.match(entries['_rels/.rels'], /Target="\/3D\/3dmodel.model"/);
});

test('rejects malformed, colored, and non-finite STL instead of silently changing it', () => {
  assert.throws(() => stlTo3mf(Buffer.alloc(10), 'part'), /binary STL/);
  assert.throws(() => stlTo3mf(Buffer.alloc(84), 'part'), /empty/);
  const source = meshBuffer([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]);
  assert.throws(() => stlTo3mf(source.subarray(0, source.length - 1), 'part'), /truncated/);
  source.writeUInt16LE(1, 84 + 48);
  assert.throws(() => stlTo3mf(source, 'part'), /attributes/);
  source.writeUInt16LE(0, 84 + 48);
  source.writeFloatLE(Infinity, 84 + 12);
  assert.throws(() => stlTo3mf(source, 'part'), /non-finite/);
});

test('worker creates a smaller copy, preserves the source, and refuses to overwrite', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-mesh-copy-'));
  const input = path.join(directory, 'source.stl');
  const output = path.join(directory, 'copy.3mf');
  const source = meshBuffer(Array.from({ length: 1000 }, () => [[0, 0, 0], [1, 0, 0], [0, 1, 0]]));
  fs.writeFileSync(input, source);
  const run = () => new Promise((resolve, reject) => {
    let report;
    const worker = new Worker(path.join(__dirname, '../mesh-copy.cjs'), { workerData: { input, output } });
    worker.once('message', result => { report = result; });
    worker.once('error', reject);
    worker.once('exit', code => code !== 0 ? reject(new Error(`Worker exited ${code}`)) : resolve(report));
  });
  try {
    const first = await run();
    assert.equal(first.error, undefined);
    assert(first.outputBytes < first.inputBytes);
    assert.deepEqual(fs.readFileSync(input), source);
    const copy = fs.readFileSync(output);
    const second = await run();
    assert.match(second.error, /EEXIST|exist/i);
    assert.deepEqual(fs.readFileSync(output), copy);
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.unlinkSync(input);
    fs.rmdirSync(directory);
  }
});
