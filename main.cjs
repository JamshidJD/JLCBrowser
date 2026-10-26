const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { endpoint, attachDiagnostics, isPerformanceTelemetry } = require('./diagnostics.cjs');
const { Worker } = require('node:worker_threads');
const { BrowserTabs } = require('./browser-tabs.cjs');
const { TranslationService, googleTranslate } = require('./translation-service.cjs');
const { createTranslationFetch } = require('./translation-network.cjs');
const { LocalTranslator } = require('./local-translator.cjs');

app.setName('JLC Browser');
const dataRoot = app.isPackaged ? path.join(app.getPath('appData'), 'JLCBrowser') : __dirname;
fs.mkdirSync(path.join(dataRoot, 'profile'), { recursive: true });
app.setPath('userData', path.join(dataRoot, 'profile'));
let browser;
let localTranslator;
const logs = path.join(dataRoot, 'diagnostics');
fs.mkdirSync(logs, { recursive: true });
const logFile = path.join(logs, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const output = fs.createWriteStream(logFile, { flags: 'a' });
output.on('error', error => {
  console.error('Cannot write diagnostics:', error.message);
  dialog.showErrorBox('Diagnostics unavailable', error.message);
  app.exit(1);
});
function write(event, detail = {}) {
  if (output.writableEnded || output.destroyed) return;
  output.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);
}

const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
function securePage(contents) {
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    write('navigation-failed', { window: contents.id, code, description, endpoint: endpoint(url), isMainFrame });
  });
  contents.on('render-process-gone', (_event, detail) => write('renderer-gone', { window: contents.id, ...detail }));
  // Chromium starts popup navigation immediately; manually opened tabs await capture readiness.
  const ready = attachDiagnostics(contents, write).catch(error => {
    write('capture-error', { window: contents.id, message: error.message });
    dialog.showErrorBox('Network capture failed', error.message);
    throw error;
  });
  return ready;
}

async function prepareUploadCopy(menuItem, window) {
  try {
    const selected = await dialog.showOpenDialog(window, {
      title: 'Create a smaller 3MF upload copy — coordinates interpreted as millimeters',
      properties: ['openFile'], filters: [{ name: 'Binary STL (up to 50 MiB)', extensions: ['stl'] }],
    });
    if (selected.canceled) return;
    const input = selected.filePaths[0];
    const destination = await dialog.showSaveDialog(window, {
      title: 'Save compressed 3MF copy', defaultPath: input.replace(/\.stl$/i, '.3mf'),
      filters: [{ name: '3MF model', extensions: ['3mf'] }],
    });
    if (destination.canceled || !destination.filePath) return;
    menuItem.enabled = false;
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'mesh-copy.cjs'), { workerData: { input, output: destination.filePath } });
      worker.once('message', report => report.error ? reject(new Error(report.error)) : resolve(report));
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Conversion worker exited with code ${code}`)); });
    });
    write('mesh-copy-created', { inputBytes: result.inputBytes, outputBytes: result.outputBytes, triangles: result.triangles, vertices: result.vertices, unit: result.unit });
    const response = await dialog.showMessageBox({
      type: 'info', title: 'Smaller upload copy ready',
      message: `${(result.inputBytes / 1e6).toFixed(2)} MB → ${(result.outputBytes / 1e6).toFixed(2)} MB`,
      detail: `${result.triangles.toLocaleString()} triangles retained, with the same coordinates and winding. Units: millimeters. Select the new .3mf file when uploading to JLC.`,
      buttons: ['Show file', 'OK'],
    });
    if (response.response === 0) shell.showItemInFolder(result.output);
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: 'Could not create upload copy', message: error.message });
  } finally { menuItem.enabled = true; }
}

app.whenReady().then(async () => {
  const skipTelemetry = !app.commandLine.hasSwitch('baseline');
  const systemDns = app.commandLine.hasSwitch('system-dns');
  if (!systemDns) {
    app.configureHostResolver({ enableBuiltInResolver: true, secureDnsMode: 'secure', secureDnsServers: ['https://1.1.1.1/dns-query'] });
  }
  write('browser-start', { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, skipTelemetry, dns: systemDns ? 'system' : 'cloudflare-doh', http2Disabled: app.commandLine.hasSwitch('disable-http2') });
  if (skipTelemetry) {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const cancel = isPerformanceTelemetry(details.url);
      if (cancel) write('telemetry-skipped', { endpoint: endpoint(details.url) });
      callback({ cancel });
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Navigate', submenu: [
      { label: 'JLC home', click: () => { void browser?.load('https://www.jlc.com/'); } },
      { label: '3D upload', click: () => { void browser?.load('https://www.jlc-3dp.cn/placeOrder'); } },
      { type: 'separator' },
      { label: 'Back', accelerator: 'Alt+Left', click: () => browser?.navigate('back') },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => browser?.navigate('forward') },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => browser?.navigate('reload') },
      { label: 'Website address', accelerator: 'CmdOrCtrl+L', click: () => browser?.focusAddress() },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Tabs', submenu: [
      { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => { void browser?.open(); } },
      { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => browser?.close() },
      { label: 'Next tab', accelerator: 'Control+Tab', click: () => browser?.cycle(1) },
      { label: 'Previous tab', accelerator: 'Control+Shift+Tab', click: () => browser?.cycle(-1) },
    ] },
    { label: 'Upload', submenu: [{ label: 'Create smaller 3MF copy (millimeters)…', click: prepareUploadCopy }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Diagnostics', submenu: [
      { label: 'Show current log', click: () => shell.showItemInFolder(logFile) },
      { label: 'Open DevTools (pauses capture for this tab)', click: () => browser?.contents?.openDevTools({ mode: 'detach' }) },
    ] },
  ]));
  const window = new BrowserWindow({ width: 1360, height: 950, minWidth: 600, minHeight: 400, title: 'JLC Browser', webPreferences: { ...preferences, backgroundThrottling: false, preload: path.join(__dirname, 'browser-preload.cjs') } });
  let translator;
  try {
    const translationNetwork = session.fromPartition('translation-network');
    const fetchTranslation = createTranslationFetch(translationNetwork);
    const translate = (text, signal) => googleTranslate(text, signal, fetchTranslation);
    localTranslator = new LocalTranslator();
    translator = new TranslationService(path.join(dataRoot, 'translations.json'), translate, {
      phrases: require('./jlc-english.json'), fallback: (text, signal) => localTranslator.translate(text, signal),
    });
  }
  catch (error) { dialog.showErrorBox('Translation cache unavailable', `${error.message}\nThe browser can still be used. Your cache has not been overwritten.`); }
  browser = new BrowserTabs(window, securePage, undefined, translator);
  await browser.initialize();
}).catch(error => {
  write('startup-failed', { message: error.message });
  dialog.showErrorBox('JLC Browser', error.message);
});

app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  write('browser-stop');
  output.end(() => { Promise.resolve(localTranslator?.close()).finally(() => app.quit()); });
});
