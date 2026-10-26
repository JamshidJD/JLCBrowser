const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

class LocalTranslator {
  constructor(modelRoot = path.join(__dirname, 'models')) {
    this.modelRoot = modelRoot;
    this.pending = new Map();
    this.serial = 0;
  }

  start() {
    if (this.worker) return;
    const worker = new Worker(__filename, { workerData: { modelRoot: this.modelRoot } });
    this.worker = worker;
    worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.text);
    });
    const failed = error => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
      this.pending.clear();
    };
    worker.once('error', failed);
    worker.once('exit', code => failed(new Error(`Local translation worker stopped (${code}).`)));
  }

  one(text, signal) {
    signal?.throwIfAborted();
    this.start();
    const id = ++this.serial;
    const canceled = new SharedArrayBuffer(4);
    return new Promise((resolve, reject) => {
      const abort = () => {
        Atomics.store(new Int32Array(canceled), 0, 1);
        this.pending.delete(id);
        cleanup(); reject(signal.reason || new Error('Local translation canceled.'));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      this.worker.postMessage({ id, text, canceled });
    });
  }

  async translate(text, signal) {
    const results = [];
    for (const label of text.split('\n')) {
      signal?.throwIfAborted();
      if (!/\p{Script=Han}/u.test(label)) throw new Error('The local fallback supports Chinese to English text only.');
      results.push(await this.one(label, signal));
    }
    return results.join('\n');
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error('Local translator closed.')); }
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}

if (!isMainThread) {
  let model, runtime;
  let queue = Promise.resolve();
  // The model is bundled and must never request models or send text over the network.
  global.fetch = async () => { throw new Error('Network access is disabled in the local translation worker.'); };
  async function load() {
    if (!model) model = (async () => {
      runtime = require('@huggingface/transformers');
      runtime.env.allowRemoteModels = false;
      runtime.env.allowLocalModels = true;
      runtime.env.useFSCache = false;
      runtime.env.useBrowserCache = false;
      runtime.env.localModelPath = `${workerData.modelRoot}${path.sep}`;
      return runtime.pipeline('translation', 'opus-mt-zh-en', {
        device: 'cpu', dtype: 'q8', local_files_only: true,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      });
    })().catch(error => { model = null; throw error; });
    return model;
  }

  parentPort.on('message', message => {
    queue = queue.then(async () => {
      const canceled = new Int32Array(message.canceled);
      const check = () => { if (Atomics.load(canceled, 0)) throw new Error('Local translation canceled.'); };
      try {
        check();
        const translate = await load();
        check();
        class Canceled extends runtime.StoppingCriteria {
          _call(tokens) { return tokens.map(() => Boolean(Atomics.load(canceled, 0))); }
        }
        const criteria = new runtime.StoppingCriteriaList(); criteria.push(new Canceled());
        const text = message.text;
        // Split long UI paragraphs to stay below the model's input window without truncating text.
        const pieces = text.match(/[^。！？.!?]{1,160}[。！？.!?]?|[。！？.!?]/gu) || [text];
        const output = [];
        for (const piece of pieces) {
          check();
          if (!/\p{Script=Han}/u.test(piece)) { output.push(piece); continue; }
          const result = await translate(piece, { max_new_tokens: 256, num_beams: 1, stopping_criteria: criteria });
          check();
          const value = result[0]?.translation_text?.trim();
          if (!value) throw new Error('The local model returned no translation.');
          output.push(value);
        }
        parentPort.postMessage({ id: message.id, text: output.join(' ') });
      } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
    });
  });
}

module.exports = { LocalTranslator };
