const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 with the installed Electron runtime.');
const metadata = require('./package.json');
const destination = path.join(__dirname, 'release', `JLCBrowser-${metadata.version}-win-x64`);
if (fs.existsSync(destination)) throw new Error(`Build destination already exists: ${destination}. Keep existing releases intact and change the version for a new release.`);
const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(runtime, destination, { recursive: true, errorOnExist: true, force: false });
fs.renameSync(path.join(destination, 'electron.exe'), path.join(destination, 'JLCBrowser.exe'));
fs.renameSync(path.join(destination, 'electron_wer.dll'), path.join(destination, 'JLCBrowser_wer.dll'));
fs.unlinkSync(path.join(destination, 'resources', 'default_app.asar'));
const application = path.join(destination, 'resources', 'app');
fs.mkdirSync(application);
const sources = ['main.cjs', 'diagnostics.cjs', 'mesh-copy.cjs', 'browser-tabs.cjs', 'browser-preload.cjs', 'browser.html', 'browser.css', 'browser-ui.js', 'translation-service.cjs', 'page-translation.cjs', 'translation-dom.js'];
for (const file of sources) fs.copyFileSync(path.join(__dirname, file), path.join(application, file), fs.constants.COPYFILE_EXCL);
const packagedMetadata = { name: metadata.name, productName: 'JLC Browser', version: metadata.version, description: metadata.description, main: metadata.main, private: true };
fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify(packagedMetadata, null, 2), { flag: 'wx' });
fs.writeFileSync(path.join(destination, 'START-HERE.txt'), 'Double-click JLCBrowser.exe to start. Keep this entire folder together.\r\nNo Node.js or npm installation is required to run it.\r\nLogin/profile and diagnostic logs are saved under %APPDATA%\\JLCBrowser.\r\nThis local build is unsigned.\r\n', { flag: 'wx' });

// Check the actual artifact, including the worker, and exclude all private development data.
assert.deepEqual(fs.readdirSync(application).sort(), [...sources, 'package.json'].sort());
for (const file of sources) assert.deepEqual(fs.readFileSync(path.join(application, file)), fs.readFileSync(path.join(__dirname, file)));
assert.equal(JSON.parse(fs.readFileSync(path.join(application, 'package.json'))).main, 'main.cjs');
assert(fs.statSync(path.join(destination, 'JLCBrowser.exe')).size > 0);
assert(!fs.existsSync(path.join(destination, 'resources', 'default_app.asar')));
console.log(`Windows app built and checked: ${path.join(destination, 'JLCBrowser.exe')}`);
