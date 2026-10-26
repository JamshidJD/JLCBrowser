const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-local-model-test-')));
// An optional app directory tests the packaged files rather than resolving from this checkout.
const application = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const { LocalTranslator } = require(path.join(application, 'local-translator.cjs'));
const { TranslationService } = require(path.join(application, 'translation-service.cjs'));
const timer = setTimeout(() => { console.error('Local model test timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const local = new LocalTranslator(path.join(application, 'models'));
  try {
    let google = 0;
    const service = new TranslationService(path.join(app.getPath('userData'), 'translations.json'), async () => {
      google++; throw Object.assign(new Error('Google unavailable for this test'), { status: 429 });
    }, { intervalMs: 0, fallback: (text, signal) => local.translate(text, signal) });
    const result = await service.translate(['请检查文件内容后重试']);
    assert.match(result.get('请检查文件内容后重试'), /file contents/i);
    assert(!/\p{Script=Han}/u.test(result.get('请检查文件内容后重试')));
    await service.translate(['预计发货时间']);
    assert.equal(google, 1, 'remaining requests use local inference during the Google cooldown');
    const restarted = new TranslationService(service.file, async () => { throw new Error('Network disabled'); });
    assert.equal((await restarted.translate(['请检查文件内容后重试'])).get('请检查文件内容后重试'), result.get('请检查文件内容后重试'));
    const canceled = new AbortController();
    const pending = local.translate('请检查文件内容后重试'.repeat(100), canceled.signal);
    canceled.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.match(await local.translate('请检查文件内容后重试'), /file contents/i, 'worker recovers after cancellation');
    console.log('Local model passed in Electron: new text translated with Google failing, no worker network access, cache reused after restart, cancellation and recovery.');
  } finally { await local.close(); clearTimeout(timer); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
