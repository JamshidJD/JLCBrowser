const { TranslationFrames } = require('./translation-frames.cjs');

class PageTranslation {
  constructor(contents, service, changed) {
    this.contents = contents;
    this.frames = new TranslationFrames(contents);
    this.service = service;
    this.changed = changed;
    this.state = { enabled: false, busy: false, error: '', saved: 0, online: 0, local: 0, remaining: 0, rateLimited: false };
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
    this.failures = 0;
    this.nextRetryAt = 0;
    this.state = { enabled: false, busy: false, error: '', saved: 0, online: 0, local: 0, remaining: 0, rateLimited: false };
    this.changed();
  }

  async run(method, value) {
    return this.frames.run(method, value);
  }

  async toggle() {
    if (this.contents.isDestroyed()) return;
    if (this.state.enabled) {
      this.reset();
      try { await this.run('restore'); } catch { /* Navigation or closing already discarded this document. */ }
      return;
    }
    this.state.enabled = true;
    this.failures = 0;
    this.nextRetryAt = 0;
    this.changed();
    this.abort = new AbortController();
    const generation = ++this.generation;
    await this.refresh(generation);
    if (generation === this.generation && this.state.enabled) this.timer = setInterval(() => { void this.refresh(generation); }, 1500);
  }

  async refresh(generation) {
    if (this.refreshing || !this.state.enabled || generation !== this.generation || this.contents.isDestroyed()) return;
    this.refreshing = true;
    const previous = JSON.stringify(this.state);
    try {
      // CSS-only visibility changes and pending requests can happen without another DOM mutation.
      const { entries, remaining } = await this.run('collect', true);
      if (generation !== this.generation) return;
      this.state.remaining = remaining;
      if (!remaining) {
        this.state.error = '';
        this.state.rateLimited = false;
        this.failures = 0;
        this.nextRetryAt = 0;
        return;
      }
      const saved = entries.filter(entry => this.service.lookup(entry.text) !== undefined);
      const missing = entries.filter(entry => this.service.lookup(entry.text) === undefined).slice(0, 250);
      if (saved.length) {
        this.state.busy = true; this.changed();
        this.state.saved += await this.run('apply', saved.map(entry => ({ ...entry, translation: this.service.lookup(entry.text) })));
      }
      if (missing.length && Date.now() >= this.nextRetryAt) {
        this.state.busy = true; this.changed();
        try {
          await this.service.translate(missing.map(entry => entry.text), this.abort.signal, async progressInfo => {
            if (generation !== this.generation) return;
            const available = missing.filter(entry => this.service.lookup(entry.text) !== undefined);
            const applied = await this.run('apply', available.map(entry => ({ ...entry, translation: this.service.lookup(entry.text) })));
            if (generation !== this.generation) return;
            if (progressInfo?.engine === 'local') this.state.local += applied;
            else if (progressInfo?.engine === 'cache') this.state.saved += applied;
            else this.state.online += applied;
            const progress = await this.run('collect', true);
            if (generation !== this.generation) return;
            this.state.remaining = progress.remaining;
            this.changed();
          });
          if (generation !== this.generation) return;
          this.failures = 0;
          this.nextRetryAt = 0;
          this.state.error = '';
          this.state.rateLimited = false;
        } catch (error) {
          if (generation !== this.generation) return;
          this.failures++;
          this.nextRetryAt = Math.max(error.retryAt || 0, Date.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures - 1, 4)));
          this.state.rateLimited = error.status === 429;
          this.state.error = this.state.rateLimited
            ? `${error.message} Retrying after ${new Date(this.nextRetryAt).toLocaleTimeString()}. Saved translations remain available.`
            : `New page text could not be translated: ${error.message} Saved translations remain available. Missing text will be retried automatically.`;
        }
        if (generation !== this.generation) return;
        // Earlier batches may already be saved even when a later batch fails.
        const available = missing.filter(entry => this.service.lookup(entry.text) !== undefined);
        if (available.length) this.state.online += await this.run('apply', available.map(entry => ({ ...entry, translation: this.service.lookup(entry.text) })));
      }
      if (generation !== this.generation) return;
      const summary = await this.run('collect', true);
      if (generation !== this.generation) return;
      this.state.remaining = summary.remaining;
      if (!this.state.remaining) {
        this.state.error = '';
        this.state.rateLimited = false;
        this.failures = 0;
        this.nextRetryAt = 0;
      }
    } catch (error) {
      if (generation === this.generation) this.state.error = `Page translation could not update: ${error.message}`;
    } finally {
      if (generation === this.generation) {
        this.refreshing = false;
        const wasBusy = this.state.busy;
        this.state.busy = false;
        if (wasBusy || previous !== JSON.stringify(this.state)) this.changed();
      }
    }
  }
}

module.exports = { PageTranslation };
