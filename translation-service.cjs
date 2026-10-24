const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t';
const MAX_ENTRIES = 10000;

async function googleTranslate(text, signal) {
  const response = await fetch(ENDPOINT, {
    method: 'POST', body: new URLSearchParams({ q: text }), credentials: 'omit', redirect: 'error',
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new Error(`Google translation returned HTTP ${response.status}.`);
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
  constructor(file, request = googleTranslate) {
    this.file = file;
    this.request = request;
    this.cache = new Map();
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Translation cache is too large to read.');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Translation cache format is not supported.');
      for (const entry of saved.entries.slice(-MAX_ENTRIES)) {
        if (Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string' && value.length <= 12000)) this.cache.set(entry[0], entry[1]);
      }
    }
  }

  lookup(text) { return this.cache.get(text); }

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

  async translate(texts, signal) {
    const unique = [...new Set(texts)];
    if (unique.some(text => typeof text !== 'string' || !text.trim() || text.length > 4000 || /[\r\n]/.test(text))) throw new Error('Unsupported translation text.');
    const missing = unique.filter(text => !this.cache.has(text));
    // The public Google endpoint has no guaranteed service contract; fail visibly if it changes.
    for (let start = 0; start < missing.length;) {
      signal?.throwIfAborted();
      const group = [];
      let size = 0;
      while (start < missing.length && group.length < 20 && (!group.length || size + missing[start].length < 1800)) {
        const text = missing[start++]; group.push(text); size += text.length + 1;
      }
      const result = await this.request(group.join('\n'), signal);
      let translations = result.trim().split(/\r?\n/).map(text => text.trim());
      // Never associate a translated paragraph with the wrong source label.
      if (translations.length !== group.length || translations.some(text => !text)) {
        translations = [];
        for (const text of group) translations.push((await this.request(text, signal)).trim());
      }
      if (translations.some(text => !text || text.length > 12000)) throw new Error('Translation response is empty or too long.');
      group.forEach((text, index) => this.cache.set(text, translations[index]));
      this.save();
    }
    return new Map(unique.map(text => [text, this.cache.get(text)]));
  }
}

module.exports = { TranslationService, googleTranslate };
