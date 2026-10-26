const { net } = require('electron');

// Electron's session.fetch cancels manual redirects; expose their headers without following them.
function createTranslationFetch(session) {
  return (url, options) => new Promise((resolve, reject) => {
    const request = net.request({ url, session, method: options.method || 'GET', redirect: 'manual', credentials: 'omit' });
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(response);
    };
    const abort = () => { finish(options.signal.reason || new Error('Translation request aborted.')); request.abort(); };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('error', error => finish(error));
    request.on('redirect', (status, _method, location) => {
      finish(null, new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on('response', response => {
      const headers = new Headers();
      for (const [name, values] of Object.entries(response.headers)) if (name.toLowerCase() !== 'set-cookie') {
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      }
      if (response.statusCode !== 200) {
        finish(null, new Response(null, { status: response.statusCode, headers }));
        request.abort(); return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) { finish(new Error('Translation response exceeded the size limit.')); request.abort(); }
        else chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('end', () => finish(null, new Response(Buffer.concat(chunks), { status: response.statusCode, headers })));
    });
    for (const [name, value] of new Headers(options.headers)) request.setHeader(name, value);
    if (options.body !== undefined) request.write(options.body.toString());
    request.end();
  });
}

module.exports = { createTranslationFetch };
