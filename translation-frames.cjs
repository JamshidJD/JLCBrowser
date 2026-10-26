const fs = require('node:fs');
const path = require('node:path');
const DOM_SOURCE = fs.readFileSync(path.join(__dirname, 'translation-dom.js'), 'utf8');
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] };

// Each frame gets its own isolated world; page scripts retain their normal origin restrictions.
class TranslationFrames {
  constructor(contents) {
    this.debugger = contents.debugger;
    this.sessions = new Map();
    this.contexts = new Map();
    this.debugger.on('message', (_event, method, params) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
        const ready = this.command('Target.setAutoAttach', AUTO_ATTACH, params.sessionId).catch(() => {});
        this.sessions.set(params.sessionId, ready);
      } else if (method === 'Target.detachedFromTarget') this.sessions.delete(params.sessionId);
    });
    this.debugger.on('detach', () => {
      this.ready = null; this.sessions.clear(); this.contexts.clear();
    });
  }

  command(method, params = {}, session) { return this.debugger.sendCommand(method, params, session); }

  async frames() {
    if (!this.debugger.isAttached()) throw new Error('Frame translation needs browser diagnostics attached. Close DevTools and restart the browser.');
    this.ready ??= this.command('Target.setAutoAttach', AUTO_ATTACH).catch(error => { this.ready = null; throw error; });
    await this.ready;
    const frames = new Map();
    for (const session of [undefined, ...this.sessions.keys()]) {
      try {
        await this.sessions.get(session);
        const { frameTree } = await this.command('Page.getFrameTree', {}, session);
        const visit = tree => {
          const frame = tree.frame;
          frames.set(frame.id, { ...frame, session });
          for (const child of tree.childFrames || []) visit(child);
        };
        visit(frameTree);
      } catch (error) { if (!session) throw error; /* A modal frame may close during discovery. */ }
    }
    return frames;
  }

  async visible(frame, frames) {
    if (!frame.parentId) return true;
    const parent = frames.get(frame.parentId);
    if (!parent || !await this.visible(parent, frames)) return false;
    let objectId;
    try {
      const owner = await this.command('DOM.getFrameOwner', { frameId: frame.id }, parent.session);
      const { object } = await this.command('DOM.resolveNode', { backendNodeId: owner.backendNodeId }, parent.session);
      objectId = object.objectId;
      const { result } = await this.command('Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function(){let node=this;while(node){if(node.closest(\'[translate="no"],.notranslate\'))return false;node=node.getRootNode().host}return this.getClientRects().length>0 && getComputedStyle(this).visibility!=="hidden"}', returnByValue: true,
      }, parent.session);
      return result.value === true;
    } finally {
      if (objectId) await this.command('Runtime.releaseObject', { objectId }, parent.session).catch(() => {});
    }
  }

  async evaluate(context, method, value) {
    const { result, exceptionDetails } = await this.command('Runtime.evaluate', {
      contextId: context.id, returnByValue: true,
      expression: `${DOM_SOURCE}\nglobalThis.__jlcTranslation.${method}(${value === undefined ? '' : JSON.stringify(value)})`,
    }, context.session);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  async run(method, value) {
    if (method === 'collect') {
      const frames = await this.frames();
      const contexts = new Map();
      const liveKeys = new Set([...frames.values()].map(frame => `${frame.session || 'main'}:${frame.id}:${frame.loaderId}`));
      const entries = [];
      let remaining = 0;
      for (const frame of frames.values()) {
        try {
          if (!await this.visible(frame, frames)) continue;
          const { executionContextId } = await this.command('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'jlc-translation' }, frame.session);
          const key = `${frame.session || 'main'}:${frame.id}:${frame.loaderId}`;
          const context = { id: executionContextId, session: frame.session };
          contexts.set(key, context);
          const batch = await this.evaluate(context, method, value);
          entries.push(...batch.entries.map(entry => ({ ...entry, frame: key })));
          remaining += batch.remaining;
        } catch (error) { if (!frame.parentId) throw error; /* Detached/navigating frames are retried on the next scan. */ }
      }
      // Keep hidden frames too so toggling off restores previously translated modals.
      for (const [key, context] of this.contexts) if (liveKeys.has(key) && !contexts.has(key)) contexts.set(key, context);
      this.contexts = contexts;
      return { entries, remaining };
    }
    let changed = 0;
    for (const [key, context] of this.contexts) {
      const entries = method === 'apply' ? value.filter(entry => entry.frame === key) : undefined;
      if (entries && !entries.length) continue;
      try { changed += (await this.evaluate(context, method, entries)) || 0; }
      catch { this.contexts.delete(key); /* The frame navigated or closed after collection. */ }
    }
    if (method === 'restore') this.contexts.clear();
    return changed;
  }
}

module.exports = { TranslationFrames };
