const { Buffer } = require('node:buffer');
// shortcut: these exact performance-script URLs may change; update after a new network capture.
const performanceTelemetry = new Set([
  'https://static.jlc.com/js/fe-monitor/prod/1.3.5/monitor.js',
  'https://static.jlc.com/js/monitor-sdk/apps/prod/3d-pc/sdp-portal-site/jlc-apm-sdk.js',
]);

function endpoint(raw) {
  try {
    const url = new URL(raw);
    return ['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)
      ? `${url.protocol}//${url.host}${url.pathname}` : url.protocol;
  } catch {
    return '[invalid URL]';
  }
}

function networkRecorder(write) {
  const requests = new Map();
  const sockets = new Map();
  return (method, p) => {
    const id = p.requestId;
    if (method === 'Network.requestWillBeSent') {
      const request = { id, endpoint: endpoint(p.request.url), method: p.request.method, started: p.timestamp };
      requests.set(id, request);
      write('request', { id, endpoint: request.endpoint, method: request.method, type: p.type });
    } else if (method === 'Network.responseReceived') {
      const request = requests.get(id);
      write('response', {
        id, endpoint: endpoint(p.response.url), status: p.response.status,
        protocol: p.response.protocol,
        elapsedMs: request ? Math.round((p.timestamp - request.started) * 1000) : null,
        timing: p.response.timing,
        fromCache: Boolean(p.response.fromDiskCache || p.response.fromServiceWorker),
      });
    } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
      const request = requests.get(id);
      write(method.endsWith('Failed') ? 'request-failed' : 'request-finished', {
        id, endpoint: request?.endpoint,
        elapsedMs: request ? Math.round((p.timestamp - request.started) * 1000) : null,
        error: p.errorText, canceled: p.canceled, blockedReason: p.blockedReason,
        corsError: p.corsErrorStatus?.corsError, receivedBytes: p.encodedDataLength,
      });
      requests.delete(id);
    } else if (method === 'Network.webSocketCreated') {
      sockets.set(id, endpoint(p.url));
      write('socket-created', { id, endpoint: sockets.get(id) });
    } else if (method === 'Network.webSocketHandshakeResponseReceived') {
      write('socket-handshake', { id, endpoint: sockets.get(id), status: p.response.status });
    } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const frame = p.response;
      write(method.endsWith('Sent') ? 'socket-sent' : 'socket-received', {
        id, opcode: frame.opcode,
        bytes: Buffer.byteLength(frame.payloadData, frame.opcode === 1 ? 'utf8' : 'base64'),
      });
    } else if (method === 'Network.webSocketFrameError' || method === 'Network.webSocketClosed') {
      write(method.endsWith('Error') ? 'socket-error' : 'socket-closed', {
        id, endpoint: sockets.get(id), error: p.errorMessage,
      });
      if (method.endsWith('Closed')) sockets.delete(id);
    }
  };
}

function uploadReceipt(body) {
  if (body.length > 65536) return { format: 'too-large' };
  let value;
  try { value = JSON.parse(body); } catch { return { format: 'non-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { format: 'non-object' };
  const result = { format: 'json' };
  if (typeof value.code === 'number' || typeof value.code === 'string') result.code = String(value.code).slice(0, 80);
  if (typeof value.success === 'boolean') result.success = value.success;
  if (typeof value.message === 'string') result.message = value.message.replace(/https?:\/\/\S+/gi, '[URL omitted]').slice(0, 512);
  return result;
}

async function attachDiagnostics(contents, write) {
  const record = networkRecorder((event, detail) => write(event, { window: contents.id, ...detail }));
  const receipts = new Map();
  const uploadEndpoints = new Set([
    'https://www.jlc-3dp.cn/3dp/file/getUploadUrl',
    'https://www.jlc-3dp.cn/3dp/file/uploadThreeDFile',
  ]);
  contents.debugger.attach('1.3');
  contents.debugger.on('message', (_event, method, params) => {
    record(method, params);
    if (method === 'Network.responseReceived' && uploadEndpoints.has(endpoint(params.response.url))) {
      receipts.set(params.requestId, { id: params.requestId, endpoint: endpoint(params.response.url), status: params.response.status });
    } else if (method === 'Network.loadingFinished' && receipts.has(params.requestId)) {
      const receipt = receipts.get(params.requestId);
      receipts.delete(params.requestId);
      void contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(response => {
        const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
        write('upload-receipt', { window: contents.id, ...receipt, ...uploadReceipt(body) });
      }).catch(error => write('upload-receipt-unavailable', { window: contents.id, ...receipt, reason: error.message }));
    } else if (method === 'Network.loadingFailed') receipts.delete(params.requestId);
  });
  contents.debugger.on('detach', (_event, reason) => write('capture-detached', { window: contents.id, reason }));
  await contents.debugger.sendCommand('Network.enable', { maxPostDataSize: 0 });
  write('capture-ready', { window: contents.id });
}

function isPerformanceTelemetry(url) {
  return performanceTelemetry.has(endpoint(url));
}

module.exports = { endpoint, networkRecorder, attachDiagnostics, isPerformanceTelemetry, uploadReceipt };
