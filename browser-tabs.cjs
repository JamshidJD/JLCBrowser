const { WebContentsView, ipcMain, Menu, clipboard, dialog } = require('electron');
const path = require('node:path');
const { PageTranslation } = require('./page-translation.cjs');

const PAGE_PREFERENCES = { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false };
const TOOLBAR_HEIGHT = 88;
const HOME = 'https://www.jlc-3dp.cn/placeOrder';
function isPageURL(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol) || url === 'about:blank'; }
  catch { return false; }
}

class BrowserTabs {
  constructor(window, securePage, home = HOME, translator = null) {
    this.window = window;
    this.securePage = securePage;
    this.home = home;
    this.translator = translator;
    this.tabs = [];
    this.active = null;
    this.disposed = false;
    this.onCommand = (event, action, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      if (action === 'new') void this.open();
      else if (action === 'select') this.select(value);
      else if (action === 'close') this.close(value);
      else if (action === 'back' || action === 'forward' || action === 'reload') this.navigate(action);
      else if (action === 'translate') void this.active?.translation?.toggle();
      else if (action === 'navigate' && typeof value === 'string') {
        const url = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
        if (isPageURL(url)) void this.load(url);
      }
    };
    ipcMain.on('browser:command', this.onCommand);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => this.publish());
    window.on('resize', () => this.layout());
    window.on('closed', () => {
      this.disposed = true;
      ipcMain.removeListener('browser:command', this.onCommand);
      for (const tab of this.tabs) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      this.tabs = [];
    });
  }

  get contents() { return this.active?.view.webContents; }

  async initialize() {
    await this.window.loadFile(path.join(__dirname, 'browser.html'));
    await this.open(this.home);
  }

  add(options = {}, foreground = true, popup = false) {
    const view = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}), webPreferences: { ...options.webPreferences, ...PAGE_PREFERENCES, preload: undefined } });
    const contents = view.webContents;
    const tab = { id: contents.id, view, error: '' };
    if (this.translator) tab.translation = new PageTranslation(contents, this.translator, () => {
      if (!contents.isDestroyed()) this.publish();
    });
    this.tabs.push(tab);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    contents.setWindowOpenHandler(details => isPageURL(details.url) ? {
      action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: PAGE_PREFERENCES },
      createWindow: childOptions => this.add(childOptions, details.disposition !== 'background-tab', true).view.webContents,
    } : { action: 'deny' });
    contents.on('will-navigate', (event, url) => { if (!isPageURL(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!isPageURL(url)) event.preventDefault(); });
    contents.on('did-start-loading', () => { tab.error = ''; this.publish(); });
    for (const event of ['page-title-updated', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) contents.on(event, () => this.publish());
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { tab.error = description; this.publish(); }
    });
    contents.on('will-prevent-unload', async () => {
      if (!tab.closeRequested) return;
      tab.closeRequested = false;
      const result = await dialog.showMessageBox(this.window, {
        type: 'question', message: 'Leave this page?', detail: 'The page has asked to stay open. Leaving may interrupt an upload or discard changes.',
        buttons: ['Stay', 'Leave'], defaultId: 0, cancelId: 0,
      });
      if (result.response === 1 && !contents.isDestroyed()) contents.close();
    });
    contents.on('context-menu', (_event, params) => {
      if (params.linkURL && isPageURL(params.linkURL)) Menu.buildFromTemplate([
        { label: 'Open link in new tab', click: () => { void this.open(params.linkURL); } },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
      ]).popup({ window: this.window });
    });
    contents.once('destroyed', () => this.remove(tab));
    // Chromium navigates popup contents after createWindow returns, preserving POSTs and opener messaging.
    // Popup setup must yield until Chromium has finished its synchronous creation callback.
    tab.ready = popup ? new Promise(resolve => setImmediate(resolve)).then(() => this.securePage(contents)) : contents.loadURL('about:blank').then(() => this.securePage(contents));
    tab.ready.catch(() => { if (!contents.isDestroyed()) contents.close(); });
    const show = () => {
      if (contents.isDestroyed() || this.disposed) return;
      if (foreground || !this.active) this.select(tab.id);
      else { this.layout(); this.publish(); }
    };
    if (popup) setImmediate(show);
    else show();
    return tab;
  }

  async open(url = this.home) {
    if (!isPageURL(url) || this.disposed) return;
    const tab = this.add();
    try {
      await tab.ready;
      if (!tab.view.webContents.isDestroyed()) await tab.view.webContents.loadURL(url);
    } catch { /* Navigation failures are recorded by securePage and shown in the tab. */ }
    return tab;
  }

  async load(url) {
    if (!this.contents || !isPageURL(url)) return;
    try { await this.contents.loadURL(url); } catch { /* Reported by did-fail-load. */ }
  }

  select(id) {
    const tab = this.tabs.find(item => item.id === id);
    if (!tab || this.disposed) return;
    this.active = tab;
    for (const item of this.tabs) item.view.setVisible(item === tab);
    this.layout();
    tab.view.webContents.focus();
    this.publish();
  }

  cycle(delta) {
    if (this.tabs.length) this.select(this.tabs[(this.tabs.indexOf(this.active) + delta + this.tabs.length) % this.tabs.length].id);
  }

  close(id = this.active?.id) {
    const tab = this.tabs.find(item => item.id === id);
    if (tab) {
      tab.closeRequested = true;
      tab.view.webContents.close({ waitForBeforeUnload: true });
    }
  }

  remove(tab) {
    if (this.disposed) return;
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    this.window.contentView.removeChildView(tab.view);
    if (!this.tabs.length) { this.active = null; this.window.close(); }
    else if (this.active === tab) this.select(this.tabs[Math.min(index, this.tabs.length - 1)].id);
    else this.publish();
  }

  layout() {
    if (this.disposed) return;
    const [width, height] = this.window.getContentSize();
    for (const tab of this.tabs) tab.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
  }

  navigate(action) {
    const contents = this.contents;
    if (!contents) return;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') contents.reload();
  }

  focusAddress() {
    this.window.webContents.focus();
    this.window.webContents.send('browser:focus-address');
  }

  publish() {
    if (this.disposed || this.window.webContents.isDestroyed()) return;
    const contents = this.contents;
    this.window.webContents.send('browser:state', {
      tabs: this.tabs.map(tab => ({ id: tab.id, title: tab.view.webContents.getTitle() || 'New tab', loading: tab.view.webContents.isLoading(), error: tab.error })),
      active: this.active?.id, url: contents?.getURL() || '', error: this.active?.error || '',
      canGoBack: contents?.navigationHistory.canGoBack() || false,
      canGoForward: contents?.navigationHistory.canGoForward() || false,
      translation: this.active?.translation?.state || null,
    });
    this.window.setTitle(`${contents?.getTitle() || 'New tab'} — JLC Browser`);
  }
}

module.exports = { BrowserTabs, PAGE_PREFERENCES, isPageURL };
