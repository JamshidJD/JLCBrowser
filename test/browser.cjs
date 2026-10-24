const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { attachDiagnostics, isPerformanceTelemetry } = require('../diagnostics.cjs');

app.whenReady().then(async () => {
  const events = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: isPerformanceTelemetry(details.url) }));
  const server = http.createServer((request, response) => {
    if (request.url === '/hang') {
      return;
    } else if (request.url.startsWith('/upload')) {
      response.writeHead(594, { 'Content-Type': 'text/plain' });
      response.end('test timeout');
    } else {
      response.end(`<script src="https://static.jlc.com/js/fe-monitor/prod/1.3.5/monitor.js"></script><script>fetch('/upload?token=private', {method:'POST',body:'private model'});const controller=new AbortController();fetch('/hang',{signal:controller.signal}).catch(()=>{});setTimeout(()=>controller.abort(),250);const ws=new WebSocket('ws://'+location.host+'/socket?token=private');ws.onopen=()=>ws.send('private');</script>`);
    }
  });
  server.on('upgrade', (request, socket) => {
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 2, 0x6f, 0x6b]));
    socket.once('data', () => socket.end(Buffer.from([0x88, 2, 3, 232])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('about:blank');
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const timer = setTimeout(() => { console.error('Browser diagnostics test timed out', events); app.exit(1); }, 15000);
  await attachDiagnostics(window.webContents, (event, detail) => {
    events.push({ event, ...detail });
    if (events.some(e => e.status === 594) && events.some(e => e.event === 'request-failed' && e.endpoint.endsWith('/hang')) && events.some(e => e.event === 'socket-sent') && events.some(e => e.event === 'socket-received')) complete();
  });
  await window.loadURL(`http://127.0.0.1:${server.address().port}`);
  await done;
  clearTimeout(timer);
  assert(events.some(e => e.status === 594 && e.endpoint.endsWith('/upload')));
  assert(events.some(e => e.event === 'socket-handshake' && e.status === 101));
  assert(events.some(e => e.event === 'request-failed' && e.endpoint.endsWith('/hang') && e.error === 'net::ERR_ABORTED'));
  assert(events.some(e => e.event === 'request-failed' && isPerformanceTelemetry(e.endpoint) && e.error === 'net::ERR_BLOCKED_BY_CLIENT'));
  assert.doesNotMatch(JSON.stringify(events), /private/);
  console.log('Browser integration passed: HTTP 594, canceled request, telemetry exclusions, and WebSocket frames captured without payloads or query strings.');
  window.destroy();
  server.closeAllConnections();
  server.close();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
