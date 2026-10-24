const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { isMainThread, workerData, parentPort } = require('node:worker_threads');

const MAX_STL_BYTES = 50 * 1024 * 1024;
const MODEL_PATH = '3D/3dmodel.model';
const MODEL_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

// These three fixed package entries are below ZIP32 limits; this is not a general archive writer.
function zipPackage(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function stlTo3mf(stl, name) {
  if (stl.length < 84 || stl.length > MAX_STL_BYTES) throw new Error('Select a binary STL between 84 bytes and 50 MiB.');
  const count = stl.readUInt32LE(80);
  if (!count || stl.length !== 84 + count * 50) throw new Error('The STL is empty, truncated, or not a supported binary STL.');
  if (stl.subarray(0, 80).includes(Buffer.from('COLOR='))) throw new Error('Colored STL requires a color-preserving exporter.');
  const vertices = [], triangles = [], indices = new Map();
  const geometry = Buffer.allocUnsafe(count * 36);
  for (let face = 0; face < count; face++) {
    const base = 84 + face * 50;
    if (stl.readUInt16LE(base + 48) !== 0) throw new Error('STL facet attributes cannot be preserved by this geometry-only converter.');
    stl.copy(geometry, face * 36, base + 12, base + 48);
    const corners = [];
    for (let corner = 0; corner < 3; corner++) {
      const start = base + 12 + corner * 12;
      const key = stl.toString('hex', start, start + 12);
      let index = indices.get(key);
      if (index === undefined) {
        const xyz = [0, 4, 8].map(delta => stl.readFloatLE(start + delta));
        if (!xyz.every(Number.isFinite)) throw new Error('STL contains a non-finite vertex coordinate.');
        const values = xyz.map(value => Object.is(value, -0) ? '-0' : String(value));
        index = vertices.length;
        indices.set(key, index);
        vertices.push(`<vertex x="${values[0]}" y="${values[1]}" z="${values[2]}"/>`);
      }
      corners.push(index);
    }
    triangles.push(`<triangle v1="${corners[0]}" v2="${corners[1]}" v3="${corners[2]}"/>`);
  }
  const escapedName = name.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="${MODEL_NS}"><resources><object id="1" type="model" name="${escapedName}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const data = zipPackage([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    [MODEL_PATH, xml],
  ]);
  return { data, triangles: count, vertices: vertices.length, inputBytes: stl.length, outputBytes: data.length, geometrySha256: crypto.createHash('sha256').update(geometry).digest('hex'), unit: 'millimeter' };
}

function createCopy(input, output) {
  if (path.extname(input).toLowerCase() !== '.stl' || path.extname(output).toLowerCase() !== '.3mf') throw new Error('Select an STL source and a new .3mf destination.');
  if (fs.statSync(input).size > MAX_STL_BYTES) throw new Error('This converter supports STL files up to 50 MiB.');
  const { data, ...report } = stlTo3mf(fs.readFileSync(input), path.basename(input, path.extname(input)));
  if (report.outputBytes >= report.inputBytes) throw new Error('The 3MF copy would not be smaller; no output was written.');
  fs.writeFileSync(output, data, { flag: 'wx' });
  return { output, ...report };
}

if (!isMainThread) {
  try { parentPort.postMessage(createCopy(workerData.input, workerData.output)); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
} else if (require.main === module) {
  try { console.log(JSON.stringify(createCopy(process.argv[2] || '', process.argv[3] || ''))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { stlTo3mf, createCopy, MODEL_PATH, MODEL_NS };
