const { test } = require('node:test');
const assert = require('node:assert/strict');
const { endpoint, networkRecorder, isPerformanceTelemetry, uploadReceipt, attachDiagnostics } = require('../diagnostics.cjs');
const { EventEmitter } = require('node:events');

test('captures application-level rejection without storage URLs, file data, or extra fields', async () => {
  const body = JSON.stringify({ code: 422, success: false, message: 'Input failed', data: { uploadUrl: 'https://storage.test/?token=secret', file: 'private' } });
  assert.deepEqual(uploadReceipt(body), { format: 'json', code: '422', success: false, message: 'Input failed' });
  assert.equal(uploadReceipt('<html>private</html>').format, 'non-json');
  assert.equal(uploadReceipt('x'.repeat(65537)).format, 'too-large');
  const events = [];
  const debuggerMock = new EventEmitter();
  debuggerMock.attach = () => {};
  debuggerMock.sendCommand = async method => method === 'Network.getResponseBody' ? { body, base64Encoded: false } : {};
  await attachDiagnostics({ id: 1, debugger: debuggerMock }, (event, detail) => events.push({ event, ...detail }));
  debuggerMock.emit('message', {}, 'Network.responseReceived', { requestId: 'receipt', timestamp: 1, response: { url: 'https://www.jlc-3dp.cn/3dp/file/getUploadUrl', status: 200 } });
  debuggerMock.emit('message', {}, 'Network.loadingFinished', { requestId: 'receipt', timestamp: 2 });
  await new Promise(resolve => setImmediate(resolve));
  const receipt = events.find(event => event.event === 'upload-receipt');
  assert.equal(receipt.status, 200);
  assert.equal(receipt.code, '422');
  assert.equal(receipt.message, 'Input failed');
  assert.doesNotMatch(JSON.stringify(events), /secret|private|storage.test/);
});

test('telemetry trial excludes only the two observed scripts, including cache query strings', () => {
  assert.equal(isPerformanceTelemetry('https://static.jlc.com/js/fe-monitor/prod/1.3.5/monitor.js?cache=1'), true);
  assert.equal(isPerformanceTelemetry('https://static.jlc.com/js/monitor-sdk/apps/prod/3d-pc/sdp-portal-site/jlc-apm-sdk.js'), true);
  assert.equal(isPerformanceTelemetry('https://static.jlc.com/js/fe-monitor/prod/1.3.5/monitor.js/other'), false);
  assert.equal(isPerformanceTelemetry('https://static.jlc.com/another-script.js'), false);
  assert.equal(isPerformanceTelemetry('https://www.jlc-3dp.cn/3dp/file/uploadThreeDFile'), false);
  assert.equal(isPerformanceTelemetry('https://passport.jlc.com/login'), false);
});

test('logs metadata for a 594 failure without credentials or bodies', () => {
  const events = [];
  const record = networkRecorder((event, detail) => events.push({ event, ...detail }));
  const url = 'https://user:password@example.test/3dp/file/uploadThreeDFile?token=secret#private';
  record('Network.requestWillBeSent', { requestId: '1', timestamp: 10, type: 'XHR', request: { url, method: 'POST', headers: { Authorization: 'secret' }, postData: 'private model' } });
  record('Network.responseReceived', { requestId: '1', timestamp: 310, response: { url, status: 594, protocol: 'h2', headers: { 'set-cookie': 'secret' } } });
  record('Network.loadingFailed', { requestId: '1', timestamp: 311, errorText: 'net::ERR_TIMED_OUT' });
  assert.equal(events[1].status, 594);
  assert.equal(events[1].elapsedMs, 300000);
  assert.equal(events[2].endpoint, 'https://example.test/3dp/file/uploadThreeDFile');
  assert.equal(events[2].error, 'net::ERR_TIMED_OUT');
  assert.doesNotMatch(JSON.stringify(events), /secret|password|private|Authorization|set-cookie/);
  assert.equal(endpoint('data:text/plain,private'), 'data:');
});

test('records socket events and frame lengths without frame contents', () => {
  const events = [];
  const record = networkRecorder((event, detail) => events.push({ event, ...detail }));
  record('Network.webSocketCreated', { requestId: 'ws1', url: 'wss://example.test/progress?token=secret' });
  record('Network.webSocketHandshakeResponseReceived', { requestId: 'ws1', response: { status: 101 } });
  record('Network.webSocketFrameSent', { requestId: 'ws1', response: { opcode: 1, payloadData: 'private' } });
  record('Network.webSocketFrameReceived', { requestId: 'ws1', response: { opcode: 2, payloadData: 'AQID' } });
  record('Network.webSocketFrameError', { requestId: 'ws1', errorMessage: 'Connection closed' });
  assert.equal(events[1].status, 101);
  assert.equal(events[2].bytes, 7);
  assert.equal(events[3].bytes, 3);
  assert.equal(events[4].event, 'socket-error');
  assert.doesNotMatch(JSON.stringify(events), /secret|private|AQID/);
});
