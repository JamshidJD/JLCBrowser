const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REVISION = '39d480d52a9ea3065a1f117adfe4dbc55de10e6f';
const MODEL_ROOT = path.join(__dirname, 'models', 'opus-mt-zh-en');
const FILES = [
  ['config.json', 1389, 'dcd3adfa622976cc4a51c68d115dc9d443d3cbd0'],
  ['generation_config.json', 293, '11cf47bfd6c2e512bf7ab5d58d49ab109732647a'],
  ['special_tokens_map.json', 74, '79ae7ea5bf033de69d0055820c57885e3d377bbb'],
  ['tokenizer.json', 6381339, '545ab64f6d0ae9bbbb0c8899f04e1ae4f805fc87'],
  ['tokenizer_config.json', 282, '9bae5b64c3a664f32d2aac60cbde97fc9e78a5ef'],
  ['onnx/encoder_model_quantized.onnx', 52899742, '84d5e171b626bc8b6b220d022ac58696e9528c25deeacca62b5cbf4364547a99'],
  ['onnx/decoder_model_merged_quantized.onnx', 60212804, 'c6b7f04ff1ba0fbd1bf6852599b4c0cad6fe512d57cd887f44ef36cf705424cb'],
];

function verify(file, bytes, hash) {
  if (!fs.existsSync(file) || fs.statSync(file).size !== bytes) return false;
  const data = fs.readFileSync(file);
  const checksum = hash.length === 64 ? crypto.createHash('sha256').update(data).digest('hex')
    : crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  return checksum === hash;
}

async function prepare() {
  for (const [name, bytes, hash] of FILES) {
    const file = path.join(MODEL_ROOT, name);
    if (verify(file, bytes, hash)) { console.log(`Verified ${name}`); continue; }
    if (fs.existsSync(file)) throw new Error(`Existing model file failed verification: ${name}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.part`;
    if (verify(temporary, bytes, hash)) { fs.renameSync(temporary, file); console.log(`Verified completed download ${name}`); continue; }
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    console.log(`Downloading ${name} (${(bytes / 1e6).toFixed(1)} MB)`);
    const response = await fetch(`https://huggingface.co/Xenova/opus-mt-zh-en/resolve/${REVISION}/${name}`, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    let received = 0, next = 10 * 1024 * 1024;
    const stream = Readable.fromWeb(response.body);
    stream.on('data', chunk => {
      received += chunk.length;
      if (received > bytes) stream.destroy(new Error('Model download exceeded its expected size.'));
      if (received >= next) { console.log(`${name}: ${(received / 1e6).toFixed(0)} MB received`); next += 10 * 1024 * 1024; }
    });
    await pipeline(stream, fs.createWriteStream(temporary, { flags: 'wx' }));
    if (!verify(temporary, bytes, hash)) throw new Error(`Downloaded model file failed verification: ${name}`);
    fs.renameSync(temporary, file);
  }
  fs.writeFileSync(path.join(MODEL_ROOT, 'MODEL-NOTICE.txt'), `Chinese to English translation model\nOriginal: Helsinki-NLP/opus-mt-zh-en, University of Helsinki Language Technology Research Group\nhttps://huggingface.co/Helsinki-NLP/opus-mt-zh-en\nLicense: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/\nONNX conversion/quantization: Xenova/opus-mt-zh-en\nhttps://huggingface.co/Xenova/opus-mt-zh-en\nPinned revision: ${REVISION}\nQuantized q8 weights; translations are machine-generated and may be inaccurate.\n`);
  console.log('Local translation model prepared and integrity-checked.');
}

if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { MODEL_ROOT, FILES, verify };
