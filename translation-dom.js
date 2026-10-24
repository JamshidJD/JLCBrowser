globalThis.__jlcTranslation ??= (() => {
  const records = new Map();
  let ids = new WeakMap();
  let serial = 0;
  let active = false;
  let dirty = true;
  const documents = new Map();
  const fonts = new Map();
  const styles = [];
  const ignored = 'script,style,noscript,textarea,input,select,option,code,pre,svg,canvas,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate';
  const observer = new MutationObserver(() => { dirty = true; });
  const markDirty = () => { dirty = true; };
  const observe = () => {
    for (const doc of documents.keys()) observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label', 'class', 'style', 'hidden'] });
  };
  function roots(doc = document) {
    const result = [doc];
    for (const frame of doc.querySelectorAll('iframe,frame')) {
      try { if (frame.getClientRects().length && frame.contentDocument?.body) result.push(...roots(frame.contentDocument)); } catch { /* Cross-origin frames retain their own content. */ }
    }
    return result;
  }
  const read = record => record.attribute ? record.node.getAttribute(record.attribute) : record.node.nodeValue;
  const write = (record, value) => record.attribute ? record.node.setAttribute(record.attribute, value) : record.node.nodeValue = value;

  function collect() {
    if (!document.body) return [];
    if (!active) {
      active = true; dirty = true;
    }
    const pages = roots();
    for (const doc of pages) if (!documents.has(doc)) {
      documents.set(doc, doc.documentElement.getAttribute('lang'));
      doc.addEventListener('scroll', markDirty, true);
      doc.addEventListener('load', markDirty, true);
      dirty = true;
    }
    observe();
    if (!dirty) return [];
    dirty = false;
    for (const [id, record] of records) if (!record.node.isConnected || !pages.includes(record.node.ownerDocument)) records.delete(id);
    const pending = [];
    function add(node, attribute = '') {
      const value = attribute ? node.getAttribute(attribute) : node.nodeValue;
      if (!value?.trim()) return;
      const text = value.trim().replace(/\s+/g, ' ');
      if (text.length > 4000 || !/[^\x00-\x7F]/.test(text) || !/\p{L}/u.test(text)) return;
      let attributes = ids.get(node);
      if (!attributes) { attributes = new Map(); ids.set(node, attributes); }
      let id = attributes.get(attribute);
      let record = records.get(id);
      if (!record) {
        id = ++serial; attributes.set(attribute, id);
        record = { node, attribute, original: value, translated: null }; records.set(id, record);
      }
      if (value === record.translated) return;
      if (value !== record.original) { record.original = value; record.translated = null; }
      if (pending.length < 250) pending.push({ id, text });
      else dirty = true;
    }
    for (const doc of pages) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent && !parent.closest(ignored) && parent.getClientRects().length && doc.defaultView.getComputedStyle(parent).visibility !== 'hidden') add(node);
    }
    for (const element of doc.body.querySelectorAll('[placeholder],[title],[aria-label]')) {
      if (element.closest('[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,script,style,svg,canvas') || !element.getClientRects().length || doc.defaultView.getComputedStyle(element).visibility === 'hidden') continue;
      for (const attribute of ['placeholder', 'title', 'aria-label']) add(element, attribute);
    }
    }
    return pending;
  }

  function apply(entries) {
    if (!active) return 0;
    observer.disconnect();
    let changed = 0;
    for (const entry of entries) {
      const record = records.get(entry.id);
      if (!record?.node.isConnected || typeof entry.translation !== 'string' || read(record) !== record.original || record.original.trim().replace(/\s+/g, ' ') !== entry.text) continue;
      const leading = record.original.match(/^\s*/)[0];
      const trailing = record.original.match(/\s*$/)[0];
      record.translated = leading + entry.translation + trailing;
      if (!record.attribute && record.node.parentElement) {
        const element = record.node.parentElement;
        if (!fonts.has(element)) {
          fonts.set(element, { value: element.style.getPropertyValue('font-family'), priority: element.style.getPropertyPriority('font-family') });
          element.style.setProperty('font-family', `Arial, ${element.ownerDocument.defaultView.getComputedStyle(element).fontFamily}, sans-serif`, 'important');
          fonts.get(element).applied = element.style.getPropertyValue('font-family');
        }
      }
      write(record, record.translated); changed++;
    }
    if (changed) for (const doc of documents.keys()) {
      doc.documentElement.setAttribute('lang', 'en');
      if (doc.location.hostname === 'www.jlc-3dp.cn' && !styles.some(style => style.ownerDocument === doc)) {
        const style = doc.createElement('style');
        style.textContent = '.craft-tab-container .tab-item{height:auto!important;min-height:80px;display:flex!important;flex-direction:column;justify-content:center;gap:6px;padding:12px 8px!important}.craft-tab-container .tab-label,.craft-tab-container .desc{height:auto!important;line-height:1.35!important;white-space:normal!important;overflow-wrap:anywhere;display:block!important}.craft-tab-container .desc{position:static!important;margin:0!important}.customize-btn{width:auto!important;white-space:nowrap!important;padding-inline:8px!important}';
        doc.head.append(style); styles.push(style);
      }
    }
    observe();
    return changed;
  }

  function restore() {
    observer.disconnect();
    for (const doc of documents.keys()) { doc.removeEventListener('scroll', markDirty, true); doc.removeEventListener('load', markDirty, true); }
    for (const record of records.values()) if (record.node.isConnected && record.translated !== null && read(record) === record.translated) write(record, record.original);
    for (const [element, font] of fonts) if (element.style.getPropertyValue('font-family') === font.applied) {
      if (font.value) element.style.setProperty('font-family', font.value, font.priority);
      else element.style.removeProperty('font-family');
    }
    for (const style of styles) style.remove();
    for (const [doc, originalLanguage] of documents) if (active && doc.documentElement.getAttribute('lang') === 'en') {
      if (originalLanguage === null) doc.documentElement.removeAttribute('lang');
      else doc.documentElement.setAttribute('lang', originalLanguage);
    }
    active = false; dirty = true; records.clear(); documents.clear(); fonts.clear(); styles.length = 0; ids = new WeakMap();
  }
  return { collect, apply, restore };
})();
