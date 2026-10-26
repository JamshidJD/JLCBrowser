const { app, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createTranslationFetch } = require('../translation-network.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jlc-translation-network-')));
const timer = setTimeout(() => { console.error('Translation networking test timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  let redirected = false, body = '', cookie;
  const server = http.createServer((request, response) => {
    cookie = request.headers.cookie;
    if (request.url === '/redirect') { response.writeHead(307, { location: '/must-not-follow' }); response.end(); }
    else if (request.url === '/must-not-follow') { redirected = true; response.end('wrong'); }
    else if (request.url === '/limit') { response.writeHead(429, { 'Retry-After': '180' }); response.end(); }
    else {
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([[['Order list', '订单列表']]])); });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const network = session.fromPartition('translation-network-test');
  await network.cookies.set({ url: base, name: 'private-session', value: 'must-not-send' });
  const fetch = createTranslationFetch(network);
  const options = { method: 'POST', body: new URLSearchParams({ q: '订单列表' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000) };
  const redirect = await fetch(`${base}/redirect`, options);
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), `${base}/must-not-follow`);
  assert.equal(redirected, false, 'native networking must not follow before the caller validates the destination');
  const result = await fetch(`${base}/translate`, options);
  assert.equal((await result.json())[0][0][0], 'Order list');
  assert.equal(body, new URLSearchParams({ q: '订单列表' }).toString());
  assert.equal(cookie, undefined, 'website/session cookies are omitted');
  const limited = await fetch(`${base}/limit`, options);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '180');
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(fetch(`${base}/translate`, { ...options, signal: canceled.signal }), { name: 'AbortError' });
  server.closeAllConnections(); server.close(); clearTimeout(timer);
  console.log('Translation networking passed: native manual redirects, response parsing, form payload, cookie exclusion, provider status/Retry-After and abort.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
