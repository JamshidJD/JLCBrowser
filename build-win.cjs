const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { MODEL_ROOT, FILES, verify } = require('./prepare-local-model.cjs');

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 with the installed Electron runtime.');
const metadata = require('./package.json');
const destination = path.join(__dirname, 'release', `JLCBrowser-${metadata.version}-win-x64`);
if (fs.existsSync(destination)) throw new Error(`Build destination already exists: ${destination}. Keep existing releases intact and change the version for a new release.`);
for (const [file, bytes, hash] of FILES) assert(verify(path.join(MODEL_ROOT, file), bytes, hash), `Prepare/verify the local model first: ${file}`);
const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(runtime, destination, { recursive: true, errorOnExist: true, force: false });
fs.renameSync(path.join(destination, 'electron.exe'), path.join(destination, 'JLCBrowser.exe'));
fs.renameSync(path.join(destination, 'electron_wer.dll'), path.join(destination, 'JLCBrowser_wer.dll'));
fs.unlinkSync(path.join(destination, 'resources', 'default_app.asar'));
const application = path.join(destination, 'resources', 'app');
fs.mkdirSync(application);
const sources = ['main.cjs', 'diagnostics.cjs', 'mesh-copy.cjs', 'browser-tabs.cjs', 'browser-preload.cjs', 'browser.html', 'browser.css', 'browser-ui.js', 'translation-service.cjs', 'translation-network.cjs', 'page-translation.cjs', 'translation-frames.cjs', 'translation-dom.js', 'jlc-english.json', 'local-translator.cjs'];
for (const file of sources) fs.copyFileSync(path.join(__dirname, file), path.join(application, file), fs.constants.COPYFILE_EXCL);
const packagedMetadata = { name: metadata.name, productName: 'JLC Browser', version: metadata.version, description: metadata.description, main: metadata.main, private: true, dependencies: metadata.dependencies };
fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify(packagedMetadata, null, 2), { flag: 'wx' });
for (const [file] of FILES) {
  const target = path.join(application, 'models', 'opus-mt-zh-en', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(MODEL_ROOT, file), target, fs.constants.COPYFILE_EXCL);
}
fs.copyFileSync(path.join(MODEL_ROOT, 'MODEL-NOTICE.txt'), path.join(application, 'models', 'opus-mt-zh-en', 'MODEL-NOTICE.txt'));
const lock = require('./package-lock.json');
for (const [relative, dependency] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/') || dependency.dev || !fs.existsSync(path.join(__dirname, relative))) continue;
  const source = path.join(__dirname, relative);
  fs.cpSync(source, path.join(application, relative), { recursive: true, filter: from => {
    if (!relative.endsWith('/onnxruntime-node')) return true;
    const part = path.relative(source, from).split(path.sep).join('/');
    return !/^bin\/napi-v3\/(?!win32(?:\/|$))/.test(part) && !/^bin\/napi-v3\/win32\/(?!x64(?:\/|$))/.test(part);
  } });
}
fs.writeFileSync(path.join(destination, 'START-HERE.txt'), 'Double-click JLCBrowser.exe to start. Keep this entire folder together, including resources and DLLs.\r\nNo Node.js or npm installation is required to run it.\r\nTranslation order: saved local text, Google, then bundled Chinese-to-English model on Google failure.\r\nThe local model is included and requires no additional download.\r\nLogin/profile and diagnostic logs are saved under %APPDATA%\\JLCBrowser.\r\nMachine translations may be inaccurate. Model attribution/license: resources\\app\\models\\opus-mt-zh-en\\MODEL-NOTICE.txt\r\nThis local build is unsigned.\r\n', { flag: 'wx' });

// Check the actual artifact, including the worker, and exclude all private development data.
assert.deepEqual(fs.readdirSync(application).sort(), [...sources, 'package.json', 'models', 'node_modules'].sort());
for (const file of sources) assert.deepEqual(fs.readFileSync(path.join(application, file)), fs.readFileSync(path.join(__dirname, file)));
assert.equal(JSON.parse(fs.readFileSync(path.join(application, 'package.json'))).main, 'main.cjs');
assert(fs.statSync(path.join(destination, 'JLCBrowser.exe')).size > 0);
assert(!fs.existsSync(path.join(destination, 'resources', 'default_app.asar')));
assert(fs.existsSync(path.join(application, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime_binding.node')));
for (const [file, bytes, hash] of FILES) assert(verify(path.join(application, 'models', 'opus-mt-zh-en', file), bytes, hash));
console.log(`Windows app built and checked: ${path.join(destination, 'JLCBrowser.exe')}`);
