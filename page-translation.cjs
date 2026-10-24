const fs = require('node:fs');
const path = require('node:path');
const DOM_SOURCE = fs.readFileSync(path.join(__dirname, 'translation-dom.js'), 'utf8');
const WORLD = 1001;

class PageTranslation {
  constructor(contents, service, changed) {
    this.contents = contents;
    this.service = service;
    this.changed = changed;
    this.state = { enabled: false, busy: false, error: '', saved: 0, online: 0 };
    this.generation = 0;
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.reset();
    });
    contents.once('destroyed', () => this.reset());
  }

  reset() {
    this.generation++;
    this.abort?.abort();
    clearInterval(this.timer);
    this.refreshing = false;
    this.state = { enabled: false, busy: false, error: '', saved: 0, online: 0 };
    this.changed();
  }

  async run(method, value) {
    return this.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `${DOM_SOURCE}\nglobalThis.__jlcTranslation.${method}(${value === undefined ? '' : JSON.stringify(value)})` }]);
  }

  async toggle() {
    if (this.contents.isDestroyed()) return;
    if (this.state.enabled) {
      this.reset();
      try { await this.run('restore'); } catch { /* Navigation or closing already discarded this document. */ }
      return;
    }
    this.state.enabled = true;
    this.changed();
    this.abort = new AbortController();
    const generation = ++this.generation;
    await this.refresh(generation);
    if (generation === this.generation && this.state.enabled) this.timer = setInterval(() => { void this.refresh(generation); }, 1500);
  }

  async refresh(generation) {
    if (this.refreshing || !this.state.enabled || generation !== this.generation || this.contents.isDestroyed()) return;
    this.refreshing = true;
    try {
        if (generation !== this.generation) return;
        const entries = await this.run('collect');
        if (!entries.length) return;
        const saved = entries.filter(entry => this.service.lookup(entry.text) !== undefined);
        const missing = entries.filter(entry => this.service.lookup(entry.text) === undefined);
        if (generation !== this.generation) return;
        this.state.busy = true; this.changed();
        if (saved.length) {
          await this.run('apply', saved.map(entry => ({ ...entry, translation: this.service.lookup(entry.text) })));
          this.state.saved += saved.length;
        }
        if (missing.length && !this.state.error) {
          const result = await this.service.translate(missing.map(entry => entry.text), this.abort.signal);
          if (generation !== this.generation) return;
          await this.run('apply', missing.map(entry => ({ ...entry, translation: result.get(entry.text) })));
          this.state.online += missing.length;
        }
    } catch {
      if (generation === this.generation) this.state.error = 'Google translation is unavailable. Saved translations are still shown. Toggle off and on to retry.';
    } finally {
      if (generation === this.generation) {
        this.refreshing = false;
        if (this.state.busy || this.state.error) { this.state.busy = false; this.changed(); }
      }
    }
  }
}

module.exports = { PageTranslation };
