const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranslationService, googleTranslate } = require('../translation-service.cjs');
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

test('all tabs share one request queue and a rate-limit cooldown; cached text stays usable', async () => {
  let calls = 0;
  const failure = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 120000 });
  const service = new TranslationService(temporaryFile(), async () => { calls++; throw failure; }, { intervalMs: 0 });
  await assert.rejects(service.translate(['新文字']), error => error.status === 429 && error.retryAt >= Date.now() + 119000);
  await assert.rejects(service.translate(['其他文字']), error => error.status === 429 && error.retryAt === service.cooldownUntil);
  assert.equal(calls, 1, 'another tab cannot send a request during the global cooldown');
  service.cache.set('已保存', 'Saved');
  assert.equal((await service.translate(['已保存'])).get('已保存'), 'Saved');
});

test('concurrent tab requests run serially and are spaced apart', async () => {
  let active = 0, peak = 0;
  const starts = [];
  const service = new TranslationService(temporaryFile(), async text => {
    starts.push(Date.now()); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return text === '甲' ? 'First' : 'Second';
  }, { intervalMs: 40 });
  await Promise.all([service.translate(['甲']), service.translate(['乙'])]);
  assert.equal(peak, 1);
  assert(starts[1] - starts[0] >= 35);
});

test('fallback saves each successful label before a later label fails', async () => {
  const service = new TranslationService(temporaryFile(), async text => {
    if (text.includes('\n')) return 'Unaligned batch';
    if (text === '甲') return 'First';
    throw new Error('later label failed');
  }, { intervalMs: 0 });
  let progress = 0;
  await assert.rejects(service.translate(['甲', '乙'], undefined, () => { progress++; }), /later label/);
  assert.equal(service.lookup('甲'), 'First');
  assert.equal(new TranslationService(service.file).lookup('甲'), 'First');
  assert.equal(progress, 1);
});

test('429 responses honor Retry-After and expose the provider status', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response('', { status: 429, headers: { 'Retry-After': '180' } });
  await assert.rejects(googleTranslate('订单列表'), error => error.status === 429 && error.retryAfterMs === 180000);
});

test('bundled verified order controls translate offline and preserve identifier/quantity values', async () => {
  const service = new TranslationService(temporaryFile(), async () => { throw new Error('must not use network'); }, { phrases: require('../jlc-english.json') });
  const result = await service.translate(['合并支付', '下载工程文件', '订单编号：TEST-42', '5片', '问题沟通历史', '下载合同', '"生产中"', '预计发货时间 :2026-11-01 12:00:00 前']);
  assert.equal(result.get('合并支付'), 'Combined payment');
  assert.equal(result.get('下载工程文件'), 'Download engineering files');
  assert.equal(result.get('订单编号：TEST-42'), 'Order number: TEST-42');
  assert.equal(result.get('5片'), '5 pcs');
  assert.equal(result.get('问题沟通历史'), 'Issue discussion history');
  assert.equal(result.get('下载合同'), 'Download contract');
  assert.equal(result.get('"生产中"'), 'In production');
  assert.equal(result.get('预计发货时间 :2026-11-01 12:00:00 前'), 'Dispatch by: 2026-11-01 12:00:00');
});

test('safe translation redirects preserve POST bodies for 307 and omit credentials', async () => {
  const calls = [];
  const result = await googleTranslate('订单列表', undefined, async (url, options) => {
    calls.push({ url, method: options.method, body: options.body?.toString(), credentials: options.credentials, redirect: options.redirect });
    if (calls.length === 1) return new Response(null, { status: 307, headers: { Location: 'https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t' } });
    return new Response(JSON.stringify([[['Order list', '订单列表']]]));
  });
  assert.equal(result, 'Order list'); assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].body, calls[0].body);
  assert(calls.every(call => call.credentials === 'omit' && call.redirect === 'manual'));
});

test('Google verification redirects are never followed and start a shared five-minute cooldown', async () => {
  let calls = 0;
  const service = new TranslationService(temporaryFile(), (text, signal) => googleTranslate(text, signal, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://www.google.com/sorry/index?continue=private' } });
  }), { intervalMs: 0 });
  await assert.rejects(service.translate(['新文字']), error => error.status === 429 && /requires verification/.test(error.message) && error.retryAt >= Date.now() + 299000);
  await assert.rejects(service.translate(['其他文字']), error => error.status === 429);
  assert.equal(calls, 1);
});

test('translation redirects cannot send text to another host, insecure URL, credentials or a non-API path', async () => {
  for (const location of ['https://example.com/translate_a/single', 'http://translate.google.com/translate_a/single', 'https://user:secret@translate.google.com/translate_a/single', 'https://translate.google.com/other']) {
    let calls = 0;
    await assert.rejects(googleTranslate('订单列表', undefined, async () => {
      calls++; return new Response(null, { status: 307, headers: { location } });
    }), /permitted translation endpoints/);
    assert.equal(calls, 1);
  }
});

test('hybrid order is saved cache, then Google, then local model; both engines persist results', async () => {
  const calls = [], engines = [];
  const file = temporaryFile();
  const service = new TranslationService(file, async text => {
    calls.push('google');
    if (text === '新标签') return 'New label';
    throw Object.assign(new Error('verification required'), { status: 429 });
  }, { intervalMs: 0, fallback: async text => { calls.push('local'); return text === '离线标签' ? 'Offline label' : 'Another label'; } });
  service.cache.set('已保存', 'Saved');
  assert.equal((await service.translate(['已保存'])).get('已保存'), 'Saved');
  assert.deepEqual(calls, []);
  assert.equal((await service.translate(['新标签'], undefined, progress => engines.push(progress.engine))).get('新标签'), 'New label');
  assert.deepEqual(calls, ['google']);
  assert.equal((await service.translate(['离线标签'], undefined, progress => engines.push(progress.engine))).get('离线标签'), 'Offline label');
  assert.deepEqual(calls, ['google', 'google', 'local']);
  assert.deepEqual(engines, ['google', 'local']);
  await service.translate(['另一个标签']);
  assert.deepEqual(calls, ['google', 'google', 'local', 'local'], 'Google cooldown uses the local model directly');
  const restarted = new TranslationService(file, async () => { throw new Error('must not use network'); });
  assert.equal((await restarted.translate(['新标签', '离线标签'])).get('离线标签'), 'Offline label');
});

test('canceling Google does not send canceled text to the local fallback', async () => {
  const controller = new AbortController(); let local = 0;
  const service = new TranslationService(temporaryFile(), async () => { controller.abort(); throw controller.signal.reason; }, { fallback: async () => { local++; return 'wrong'; } });
  await assert.rejects(service.translate(['新标签'], controller.signal), { name: 'AbortError' });
  assert.equal(local, 0);
});
