const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { BrowserTabs } = require('../browser-tabs.cjs');
const { TranslationService } = require('../translation-service.cjs');
const { attachDiagnostics } = require('../diagnostics.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-translation-ui-'));
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Translation test timed out'); app.exit(1); }, 45000);
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  let calls = 0, pageLoads = 0, hold;
  const dictionary = { '上传图纸': 'Upload drawings', '打印须知': 'Printing instructions', '历史上传记录': 'Upload history', '新增内容': 'New content' };
  const service = new TranslationService(path.join(directory, 'translations.json'), async text => {
    calls++;
    return text.split('\n').map(value => { assert(value in dictionary, `Unexpected/private text: ${value}`); return dictionary[value]; }).join('\n');
  });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/hold') { hold = response; return; }
    if (request.url === '/frame') { response.end('<html lang="zh"><body><p id="frame-label">打印须知</p></body></html>'); return; }
    pageLoads++;
    response.end('<html lang="zh-CN"><body><p id="label">  上传图纸  </p><button id="action" onclick="this.dataset.clicked=1">打印须知</button><input id="entered" value="私密输入" placeholder="上传图纸"><input type="password" value="密码不可发送"><input id="file" type="file"><textarea>私密草稿</textarea><div contenteditable="true">编辑内容</div><p hidden>隐藏隐私</p><p translate="no">禁止翻译</p><span id="tip" title="打印须知">English</span><div id="dynamic"></div><iframe src="/frame"></iframe><script>window.holding=fetch("/hold")</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, '..', 'browser-preload.cjs') } });
  const browser = new BrowserTabs(window, contents => attachDiagnostics(contents, () => {}), origin, service);
  await browser.initialize();
  const contents = browser.contents;
  const tab = browser.active;
  const read = expression => contents.executeJavaScript(expression);
  const file = path.join(directory, 'kept.stl'); fs.writeFileSync(file, 'local fixture');
  const root = await contents.debugger.sendCommand('DOM.getDocument');
  const selector = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#file' });
  await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: selector.nodeId, files: [file] });
  await until(async () => await window.webContents.executeJavaScript('!document.querySelector("#translate").disabled'), 'toolbar enabled');
  await window.webContents.executeJavaScript('document.querySelector("#translate").click()');
  await until(async () => await read('document.querySelector("#label").textContent') === '  Upload drawings  ' && !tab.translation.state.busy, 'translated page');
  assert.equal(await read('document.querySelector("iframe").contentDocument.querySelector("p").textContent'), 'Printing instructions');
  assert.equal(await read('document.documentElement.lang'), 'en');
  assert.equal(await read('document.querySelector("#entered").value'), '私密输入');
  assert.equal(await read('document.querySelector("#entered").placeholder'), 'Upload drawings');
  assert.equal(await read('document.querySelector("textarea").value'), '私密草稿');
  assert.equal(await read('document.querySelector("#file").files[0].name'), 'kept.stl');
  assert.equal(contents.getURL(), `${origin}/`);
  assert.equal(hold.destroyed, false, 'pending request survives translation');
  await read('document.querySelector("#action").click()');
  assert.equal(await read('document.querySelector("#action").dataset.clicked'), '1', 'original handlers survive');
  await read('document.querySelector("#dynamic").textContent="新增内容"');
  await until(async () => await read('document.querySelector("#dynamic").textContent') === 'New content', 'dynamic text');
  await tab.translation.toggle();
  assert.equal(await read('document.querySelector("#label").textContent'), '  上传图纸  ');
  assert.equal(await read('document.querySelector("#tip").title'), '打印须知');
  assert.equal(await read('document.documentElement.lang'), 'zh-CN');
  assert.equal(await read('document.querySelector("iframe").contentDocument.documentElement.lang'), 'zh');
  assert.equal(await read('document.querySelector("#entered").placeholder'), '上传图纸');
  const beforeOffline = calls;
  const offline = new TranslationService(service.file, async () => { throw new Error('offline'); });
  tab.translation.service = offline;
  await tab.translation.toggle();
  assert.equal(await read('document.querySelector("#label").textContent'), '  Upload drawings  ');
  assert.equal(tab.translation.state.online, 0);
  assert(tab.translation.state.saved > 0);
  assert.equal(calls, beforeOffline);
  await read('document.querySelector("#dynamic").textContent="未缓存的内容"');
  await until(() => Boolean(tab.translation.state.error), 'offline uncached text reports error');
  assert.equal(await read('document.querySelector("#label").textContent'), '  Upload drawings  ');
  await tab.translation.toggle();
  assert.equal(await read('document.querySelector("#dynamic").textContent'), '未缓存的内容');
  assert.equal(pageLoads, 1, 'translation and restoring never reload the page');
  assert.equal(hold.destroyed, false);
  assert.equal(await read('typeof window.browser+":"+typeof window.__jlcTranslation'), 'undefined:undefined', 'translation engine is isolated from site JavaScript');
  await read('document.querySelector("#dynamic").textContent="新增内容"');
  let finishRequest;
  tab.translation.service = new TranslationService(path.join(directory, 'delayed.json'), text => new Promise(resolve => {
    finishRequest = () => resolve(text.split('\n').map(value => dictionary[value]).join('\n'));
  }));
  const delayed = tab.translation.toggle();
  await until(() => Boolean(finishRequest), 'delayed translation request');
  await tab.translation.toggle();
  finishRequest();
  await delayed;
  assert.equal(await read('document.querySelector("#label").textContent'), '  上传图纸  ', 'late response cannot retranslate after toggling off');
  assert.equal(tab.translation.state.enabled, false);
  window.destroy();
  server.closeAllConnections(); server.close();
  clearTimeout(timeout);
  console.log('Translation passed: in-place UI toggle, exact restore, frames, dynamic content, private inputs, file selection, click handlers, pending request, persistent offline cache and visible offline errors.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
