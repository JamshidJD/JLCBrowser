const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranslationService } = require('../translation-service.cjs');
const temporaryFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-translation-')), 'translations.json');

test('deduplicates text, persists translations, and reuses the cache after restart without network', async () => {
  const file = temporaryFile(); let calls = 0;
  const service = new TranslationService(file, async text => { calls++; return text.replace('上传图纸', 'Upload drawings').replace('打印须知', 'Printing instructions'); });
  const result = await service.translate(['上传图纸', '打印须知', '上传图纸']);
  assert.equal(result.get('上传图纸'), 'Upload drawings');
  assert.equal(calls, 1);
  const offline = new TranslationService(file, async () => { throw new Error('No network allowed'); });
  assert.equal((await offline.translate(['打印须知'])).get('打印须知'), 'Printing instructions');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('misaligned batch response falls back to individual labels without mismatching them', async () => {
  const service = new TranslationService(temporaryFile(), async text => text.includes('\n') ? 'Combined paragraph' : ({ '甲': 'First', '乙': 'Second' })[text]);
  const result = await service.translate(['甲', '乙']);
  assert.equal(result.get('甲'), 'First'); assert.equal(result.get('乙'), 'Second');
});

test('offline failure keeps previously saved entries and cancellation avoids new requests', async () => {
  const file = temporaryFile();
  const service = new TranslationService(file, async () => 'Upload');
  await service.translate(['上传']);
  service.request = async () => { throw new Error('offline'); };
  await assert.rejects(service.translate(['新文字']), /offline/);
  assert.equal(new TranslationService(file).lookup('上传'), 'Upload');
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(service.translate(['其他文字'], canceled.signal), { name: 'AbortError' });
  await assert.rejects(service.translate(['invalid\njoined label']), /Unsupported/);
});

test('corrupt cache is preserved rather than overwritten', () => {
  const file = temporaryFile(); fs.writeFileSync(file, '{broken');
  assert.throws(() => new TranslationService(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
