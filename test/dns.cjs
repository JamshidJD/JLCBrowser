const { app, session, net } = require('electron');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  app.configureHostResolver({ enableBuiltInResolver: true, secureDnsMode: 'secure', secureDnsServers: ['https://1.1.1.1/dns-query'] });
  const timer = setTimeout(() => { console.error('Secure DNS test timed out'); app.exit(1); }, 20000);
  for (const host of ['passport.jlc.com', 'www.jlc-3dp.cn']) {
    const result = await session.defaultSession.resolveHost(host, { queryType: 'A', cacheUsage: 'disallowed' });
    assert(result.endpoints.length > 0);
    console.log(`Secure DNS resolved ${host}: ${result.endpoints.length} address(es).`);
  }
  const login = await net.fetch('https://passport.jlc.com/login', { redirect: 'manual' });
  assert(login.status >= 200 && login.status < 400, `Login returned HTTP ${login.status}`);
  await login.body?.cancel();
  console.log(`Public login page reached over HTTPS: HTTP ${login.status}.`);
  clearTimeout(timer);
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
