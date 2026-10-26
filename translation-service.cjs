const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t';
const MAX_ENTRIES = 10000;

async function googleTranslate(text, signal, fetchRequest = fetch) {
  const options = {
    method: 'POST', body: new URLSearchParams({ q: text }), credentials: 'omit', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  };
  let url = ENDPOINT, response;
  for (let redirects = 0; ; redirects++) {
    response = await fetchRequest(url, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Translation redirect did not include a destination.');
    const target = new URL(location, url);
    if ((['www.google.com', 'google.com'].includes(target.hostname) && target.pathname.startsWith('/sorry/')) || target.hostname === 'consent.google.com') {
      const error = new Error('Google requires verification before online translation can continue. Saved and bundled translations remain available.');
      error.status = 429; error.retryAfterMs = 300000;
      throw error;
    }
    if (target.protocol !== 'https:' || target.port || target.username || target.password || !['translate.googleapis.com', 'translate.google.com'].includes(target.hostname) || target.pathname !== '/translate_a/single') throw new Error('Google redirected outside the permitted translation endpoints.');
    if (redirects >= 3) throw new Error('Google translation returned too many redirects.');
    if (response.status === 303 || ([301, 302].includes(response.status) && options.method === 'POST')) { options.method = 'GET'; delete options.body; }
    url = target.href;
  }
  if (!response.ok) {
    const error = new Error(`Google translation returned HTTP ${response.status}.`);
    error.status = response.status;
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header && Number(header);
      const requested = Number.isFinite(seconds) && seconds !== null ? seconds * 1000 : Date.parse(header) - Date.now();
      error.retryAfterMs = Math.max(60000, Number.isFinite(requested) ? requested : 0);
    }
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 512 * 1024) throw new Error('Translation response exceeded the size limit.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(value?.[0]) || !value[0].every(segment => typeof segment?.[0] === 'string')) throw new Error('Google returned an unexpected translation response.');
  return value[0].map(segment => segment[0]).join('');
}

class TranslationService {
  constructor(file, request = googleTranslate, { intervalMs = 1200, phrases = [], fallback = null } = {}) {
    this.file = file;
    this.request = request;
    this.fallback = fallback;
    this.cache = new Map(phrases);
    this.intervalMs = intervalMs;
    this.nextRequestAt = 0;
    this.cooldownUntil = 0;
    this.queue = Promise.resolve();
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Translation cache is too large to read.');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Translation cache format is not supported.');
      for (const entry of saved.entries.slice(-MAX_ENTRIES)) {
        if (Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string' && value.length <= 12000)) this.cache.set(entry[0], entry[1]);
      }
    }
    for (const [source, target] of phrases) this.cache.set(source, target);
  }

  lookup(text) {
    const saved = this.cache.get(text);
    if (saved !== undefined) return saved;
    // Preserve identifiers and quantities exactly when only the fixed UI label changes.
    const order = text.match(/^订单编号[：:]\s*(\S{1,80})$/);
    if (order) return `Order number: ${order[1]}`;
    const quantity = text.match(/^(\d+)片$/);
    if (quantity) return `${quantity[1]} pcs`;
    const dispatch = text.match(/^预计发货时间\s*[：:]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*前$/);
    if (dispatch) return `Dispatch by: ${dispatch[1]}`;
    return undefined;
  }

  requestText(text, signal) {
    const pending = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (Date.now() < this.cooldownUntil) {
        if (this.fallback) return { text: await this.fallback(text, signal), engine: 'local' };
        const error = new Error('Google has temporarily limited translation requests.');
        error.status = 429; error.retryAt = this.cooldownUntil;
        throw error;
      }
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      signal?.throwIfAborted();
      this.nextRequestAt = Date.now() + this.intervalMs;
      try { return { text: await this.request(text, signal), engine: 'google' }; }
      catch (error) {
        if (signal?.aborted) throw error;
        if (error.status === 429) {
          this.cooldownUntil = Date.now() + Math.max(60000, error.retryAfterMs || 0);
          error.retryAt = this.cooldownUntil;
        }
        if (this.fallback) {
          // Avoid repeatedly waiting on a failed provider while the local model is working.
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + 60000);
          return { text: await this.fallback(text, signal), engine: 'local' };
        }
        throw error;
      }
    });
    // One queue/cooldown is shared by every tab using this service.
    this.queue = pending.catch(() => {});
    return pending;
  }

  save() {
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    let size = [...this.cache].reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 64);
    for (const [source, target] of this.cache) {
      if (size <= 16 * 1024 * 1024) break;
      size -= Buffer.byteLength(JSON.stringify([source, target])) + 1;
      this.cache.delete(source);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, target: 'en', entries: [...this.cache] }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  async translate(texts, signal, onProgress) {
    const unique = [...new Set(texts)];
    if (unique.some(text => typeof text !== 'string' || !text.trim() || text.length > 4000 || /[\r\n]/.test(text))) throw new Error('Unsupported translation text.');
    const missing = unique.filter(text => this.lookup(text) === undefined);
    // The public Google endpoint has no guaranteed service contract; fail visibly if it changes.
    for (let start = 0; start < missing.length;) {
      signal?.throwIfAborted();
      const group = [];
      let size = 0;
      while (start < missing.length && group.length < 20 && (!group.length || size + missing[start].length < 1800)) {
        const text = missing[start++]; group.push(text); size += text.length + 1;
      }
      const result = await this.requestText(group.join('\n'), signal);
      let translations = result.text.trim().split(/\r?\n/).map(text => text.trim());
      // Never associate a translated paragraph with the wrong source label.
      if (translations.length !== group.length || translations.some(text => !text)) {
        translations = [];
        for (const text of group) {
          const item = this.cache.has(text) ? { text: this.cache.get(text), engine: 'cache' } : await this.requestText(text, signal);
          const translated = item.text.trim();
          if (!translated || translated.length > 12000) throw new Error('Translation response is empty or too long.');
          translations.push(translated);
          this.cache.set(text, translated);
          this.save();
          await onProgress?.({ engine: item.engine });
        }
      }
      if (translations.some(text => !text || text.length > 12000)) throw new Error('Translation response is empty or too long.');
      group.forEach((text, index) => this.cache.set(text, translations[index]));
      this.save();
      await onProgress?.({ engine: result.engine });
    }
    return new Map(unique.map(text => [text, this.lookup(text)]));
  }
}

module.exports = { TranslationService, googleTranslate };
