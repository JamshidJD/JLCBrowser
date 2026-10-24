const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { BrowserTabs, isPageURL } = require('../browser-tabs.cjs');
const { attachDiagnostics } = require('../diagnostics.cjs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-tabs-test-')));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Tab integration timed out'); app.exit(1); }, 45000);
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  let posted = '';
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.method === 'POST') {
      request.on('data', chunk => { posted += chunk; });
      request.on('end', () => response.end('<title>Posted tab</title>'));
    } else if (request.url === '/child') {
      response.end('<title>Child tab</title><script>if(window.opener)window.opener.postMessage("child-ready",location.origin)</script>');
    } else if (request.url === '/next') response.end('<title>Next page</title>');
    else {
      response.setHeader('Set-Cookie', 'sharedSession=present; Path=/; SameSite=Lax');
      response.end('<title>Original tab</title><a id="link" href="/child" target="_blank" rel="opener">New tab</a><form id="post" action="/post" method="POST" target="_blank"><input name="probe" value="preserved"></form><script>window.childMessage="";onmessage=e=>window.childMessage=e.data</script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const listenerCount = ipcMain.listenerCount('browser:command');
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, '..', 'browser-preload.cjs') } });
  const browser = new BrowserTabs(window, contents => attachDiagnostics(contents, (event, detail) => events.push({ event, ...detail })), origin);
  await browser.initialize();
  const original = browser.contents;
  await until(async () => await window.webContents.executeJavaScript('document.querySelectorAll(".tab").length') === 1, 'initial tab strip');
  assert.equal(await original.executeJavaScript('typeof require + ":" + typeof window.browser'), 'undefined:undefined');

  await original.executeJavaScript('document.querySelector("#link").click()', true);
  await until(() => browser.tabs.length === 2 && browser.contents.getTitle() === 'Child tab', 'target=_blank');
  const child = browser.contents;
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'popup stays inside the one browser window');
  assert.match(await child.executeJavaScript('document.cookie'), /sharedSession=present/);
  await until(async () => await original.executeJavaScript('window.childMessage') === 'child-ready', 'opener postMessage');
  assert(events.some(event => event.event === 'capture-ready' && event.window === child.id), 'popup capture attached');

  browser.select(original.id);
  const backgroundTab = browser.add({}, false);
  await backgroundTab.ready;
  await backgroundTab.view.webContents.loadURL(`${origin}/child`);
  await until(() => browser.tabs.length === 3 && browser.tabs.at(-1).view.webContents.getTitle() === 'Child tab', 'background tab');
  assert.equal(browser.contents, original, 'background link keeps original tab selected');
  const background = browser.tabs.at(-1).view.webContents;
  browser.close(background.id);
  await until(() => background.isDestroyed() && browser.tabs.length === 2, 'close background tab');

  browser.select(original.id);
  await original.executeJavaScript('document.querySelector("#post").submit()', true);
  await until(() => browser.tabs.length === 3 && browser.contents.getTitle() === 'Posted tab', 'target=_blank POST');
  assert.equal(posted, 'probe=preserved', 'native popup handling preserves POST body');
  const postedContents = browser.contents;
  browser.close();
  await until(() => postedContents.isDestroyed() && browser.tabs.length === 2, 'close active tab');
  browser.select(original.id);
  assert.equal(child.isDestroyed(), false, 'switching and closing another tab leaves child alive');
  await original.executeJavaScript('window.pending=window.open("about:blank");pending.location="/child";', true);
  await until(() => browser.tabs.length === 3 && browser.contents.getTitle() === 'Child tab', 'blank popup then navigation');
  const blankChild = browser.contents;
  await blankChild.executeJavaScript('window.close()');
  await until(() => blankChild.isDestroyed() && browser.tabs.length === 2, 'script-closing popup');

  browser.select(original.id);
  browser.cycle(1);
  assert.equal(browser.contents, child);
  assert.equal(original.isDestroyed(), false);
  browser.cycle(-1);
  assert.equal(browser.contents, original);
  await browser.load(`${origin}/next`);
  assert.equal(original.navigationHistory.canGoBack(), true);
  browser.navigate('back');
  await until(() => original.getTitle() === 'Original tab', 'active tab back navigation');
  await original.executeJavaScript('window.open("file:///C:/Windows/win.ini")', true);
  assert.equal(browser.tabs.length, 2, 'file popup rejected');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/test', 'invalid']) assert.equal(isPageURL(url), false);
  browser.onCommand({ sender: original }, 'navigate', 'https://example.com/');
  assert.equal(original.getURL(), `${origin}/`, 'web page cannot send browser commands');

  await window.webContents.executeJavaScript('document.querySelector("#new-tab").click()');
  await until(() => browser.tabs.length === 3 && browser.contents.getTitle() === 'Original tab', 'new tab button and preload IPC');
  await until(async () => await window.webContents.executeJavaScript('document.querySelectorAll(".tab").length') === 3, 'updated tab strip');
  window.setContentSize(650, 450);
  browser.layout();
  assert.deepEqual(browser.active.view.getBounds(), { x: 0, y: 88, width: 650, height: 362 });
  const allContents = browser.tabs.map(tab => tab.view.webContents);
  browser.close(original.id);
  await until(() => original.isDestroyed(), 'closing opener');
  assert.equal(child.isDestroyed(), false, 'child outlives opener tab');
  window.destroy();
  await until(() => allContents.every(contents => contents.isDestroyed()), 'window teardown closes every tab');
  assert.equal(ipcMain.listenerCount('browser:command'), listenerCount);
  server.closeAllConnections();
  server.close();
  console.log('Tabs passed: real blank/target links, POST popups, shared session, opener messaging, switching, closing, navigation, restricted IPC, UI commands, resize, diagnostics and teardown.');
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
