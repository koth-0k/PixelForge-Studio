const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const isDev = !app.isPackaged;
const droppedImageTypes = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' });
const MAX_DROPPED_IMAGE_BYTES = 100 * 1024 * 1024;
const PROJECT_MAGIC = Buffer.from([80, 70, 71, 80, 82, 79, 74, 0]);
const PROJECT_FORMAT = 'PixelForge Studio Project';
const PROJECT_VERSION = 1;
const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const MAX_PROJECT_MANIFEST_BYTES = 32 * 1024 * 1024;
let win;
let logPath;
let closeAuthorized = false;
let closePromptPending = false;
function log(level, message, detail) {
  const line = `${new Date().toISOString()} [${level}] ${message}${detail === undefined ? '' : ` ${detail instanceof Error ? detail.stack || detail.message : typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`;
  try { if (logPath) require('node:fs').appendFileSync(logPath, line); } catch { /* Logging must not crash the application. */ }
  if (isDev) {
    try { if (level === 'ERROR') console.error(line); else console.log(line); } catch { /* A closed development console must not interrupt IPC or startup. */ }
  }
}
function isTrustedMainFrame(event) {
  const frame = event.senderFrame;
  const url = frame?.url || '';
  const expectedUrl = isDev
    ? url === 'http://127.0.0.1:5173/'
    : url.startsWith('file://') && url.endsWith('/dist/index.html');
  return Boolean(win && event.sender === win.webContents && frame && frame === event.sender.mainFrame && expectedUrl);
}
function assertTrustedMainFrame(event) {
  if (!isTrustedMainFrame(event)) throw new Error('Blocked IPC request from an untrusted renderer');
}
function validateProjectManifest(manifest) {
  if (!manifest || manifest.format !== PROJECT_FORMAT) throw new Error('This is not a PixelForge Studio project.');
  if (manifest.version !== PROJECT_VERSION) throw new Error(`Unsupported project version ${String(manifest.version)}.`);
  if (!manifest.document || typeof manifest.document !== 'object' || !Array.isArray(manifest.document.layers)) throw new Error('The project document data is incomplete.');
}
async function readProjectFile(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.pforge') throw new Error('Choose a PixelForge Studio .pforge project.');
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_PROJECT_BYTES) throw new Error('The project size is invalid or exceeds the 256 MB safety limit.');
    const readExact = async (length, position) => {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, position + read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      return read === length ? buffer : null;
    };
    const header = await readExact(12, 0);
    if (!header || !header.subarray(0, 8).equals(PROJECT_MAGIC)) throw new Error('The file does not have a PixelForge project signature.');
    const manifestLength = header.readUInt32LE(8);
    if (!manifestLength || manifestLength > MAX_PROJECT_MANIFEST_BYTES || 12 + manifestLength > stat.size) throw new Error('The project manifest length is invalid.');
    const manifestBytes = await readExact(manifestLength, 12);
    if (!manifestBytes) throw new Error('The project manifest is incomplete.');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('The project manifest is corrupted.'); }
    validateProjectManifest(manifest);
    if (!Array.isArray(manifest.assets) || manifest.assets.length > 100000) throw new Error('The project asset directory is invalid.');
    const payloadOffset = 12 + manifestLength;
    const payloadLength = stat.size - payloadOffset;
    const assets = [];
    const seen = new Set();
    let expectedOffset = 0;
    for (const descriptor of manifest.assets) {
      if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.length > 200 || seen.has(descriptor.id)) throw new Error('The project has an invalid or duplicate asset ID.');
      seen.add(descriptor.id);
      if (!Number.isSafeInteger(descriptor.offset) || descriptor.offset !== expectedOffset || !Number.isSafeInteger(descriptor.length) || descriptor.length < 1 || descriptor.offset + descriptor.length > payloadLength) throw new Error(`Project asset ${descriptor.id} has an invalid range.`);
      if (!['image/png', 'application/x-pforge-selection-tile'].includes(descriptor.mimeType)) throw new Error(`Project asset ${descriptor.id} has an unsupported type.`);
      const data = await readExact(descriptor.length, payloadOffset + descriptor.offset);
      if (!data) throw new Error(`Project asset ${descriptor.id} is incomplete.`);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (hash !== descriptor.sha256) throw new Error(`Project asset ${descriptor.id} failed its integrity check.`);
      assets.push({ id: descriptor.id, mimeType: descriptor.mimeType, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
      expectedOffset += descriptor.length;
    }
    if (expectedOffset !== payloadLength) throw new Error('The project contains trailing or missing binary data.');
    log('INFO', 'Native project opened', { filePath, layers: manifest.document.layers.length, assets: assets.length, bytes: stat.size });
    return { path: filePath, manifest, assets };
  } finally { await handle.close(); }
}
async function writeBufferAtomically(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(cleanupError => log('ERROR', 'Temporary export cleanup failed', cleanupError));
    throw error;
  }
}
async function writeProjectFile(filePath, payload) {
  const manifest = JSON.parse(JSON.stringify(payload?.manifest));
  validateProjectManifest(manifest);
  if (!Array.isArray(payload?.assets) || payload.assets.length > 100000) throw new Error('The project asset list is invalid.');
  const seen = new Set();
  let totalAssetBytes = 0;
  const assets = payload.assets.map(asset => {
    if (!asset || typeof asset.id !== 'string' || asset.id.length > 200 || seen.has(asset.id)) throw new Error('The project has an invalid or duplicate asset ID.');
    seen.add(asset.id);
    if (!(asset.data instanceof Uint8Array) || asset.data.byteLength < 1) throw new Error(`Project asset ${asset.id} is empty or invalid.`);
    if (!['image/png', 'application/x-pforge-selection-tile'].includes(asset.mimeType)) throw new Error(`Project asset ${asset.id} has an unsupported type.`);
    if (asset.mimeType === 'application/x-pforge-selection-tile' && asset.data.byteLength !== 128 * 128) throw new Error(`Project selection tile ${asset.id} has an invalid size.`);
    if (asset.mimeType === 'image/png' && (asset.data[0] !== 137 || asset.data[1] !== 80 || asset.data[2] !== 78 || asset.data[3] !== 71)) throw new Error(`Project image asset ${asset.id} is not a PNG.`);
    totalAssetBytes += asset.data.byteLength;
    if (totalAssetBytes + MAX_PROJECT_MANIFEST_BYTES + 12 > MAX_PROJECT_BYTES) throw new Error('The project exceeds the 256 MB safety limit.');
    return { id: asset.id, data: Buffer.from(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength), mimeType: asset.mimeType };
  });
  const descriptors = [];
  let offset = 0;
  for (const asset of assets) {
    descriptors.push({ id: asset.id, offset, length: asset.data.length, sha256: crypto.createHash('sha256').update(asset.data).digest('hex'), mimeType: asset.mimeType });
    offset += asset.data.length;
  }
  manifest.assets = descriptors;
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > MAX_PROJECT_MANIFEST_BYTES) throw new Error('The project manifest exceeds the 32 MB limit.');
  const header = Buffer.alloc(12);
  PROJECT_MAGIC.copy(header, 0); header.writeUInt32LE(manifestBytes.length, 8);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx');
    await handle.writeFile(header);
    await handle.writeFile(manifestBytes);
    for (const asset of assets) await handle.writeFile(asset.data);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporaryPath, filePath);
    log('INFO', 'Native project saved', { filePath, layers: manifest.document.layers.length, assets: assets.length, bytes: 12 + manifestBytes.length + totalAssetBytes });
    return filePath;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
process.on('uncaughtException', error => log('ERROR', 'Main-process uncaught exception', error));
process.on('unhandledRejection', reason => log('ERROR', 'Main-process unhandled rejection', reason));
app.on('render-process-gone', (_event, webContents, details) => log('ERROR', 'Renderer process gone', { id: webContents.id, ...details }));
app.on('child-process-gone', (_event, details) => log('ERROR', 'Child process gone', details));
app.on('gpu-process-crashed', (_event, killed) => log('ERROR', 'GPU process crashed', { killed }));

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  const rendererPath = path.join(__dirname, '../dist/index.html');
  log('INFO', 'Creating main window', { packaged: app.isPackaged, preloadPath, rendererPath, preloadExists: require('node:fs').existsSync(preloadPath), rendererExists: require('node:fs').existsSync(rendererPath) });
  win = new BrowserWindow({ width: 1500, height: 940, minWidth: 1080, minHeight: 680, show: false, autoHideMenuBar: true, backgroundColor: '#111214', title: 'PixelForge Studio', icon: path.join(__dirname, '../assets/pixelforge.ico'), webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.once('ready-to-show', () => { log('INFO', 'Window ready to show'); win.show(); win.focus(); });
  win.webContents.on('did-finish-load', () => log('INFO', 'Renderer finished loading', { url: win.webContents.getURL() }));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => log('ERROR', 'Renderer failed to load', { code, description, url, isMainFrame }));
  win.webContents.on('preload-error', (_event, preload, error) => log('ERROR', 'Preload failed', { preload, error: error.stack || error.message }));
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => log(level >= 2 ? 'ERROR' : 'RENDERER', 'Renderer console', { level, message, line, source: sourceId }));
  win.webContents.on('render-process-gone', (_event, details) => log('ERROR', 'Window renderer process gone', details));
  win.webContents.on('will-navigate', (event, url) => { const allowed = isDev ? url.startsWith('http://127.0.0.1:5173') : url.startsWith('file://'); if (!allowed) { log('WARN', 'Blocked navigation', url); event.preventDefault(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { log('INFO', 'External window requested', url); shell.openExternal(url).catch(error => log('ERROR', 'External open failed', error)); return { action: 'deny' }; });
  const load = isDev ? win.loadURL('http://127.0.0.1:5173') : win.loadFile(rendererPath);
  load.catch(error => { log('ERROR', 'Window load promise rejected', error); dialog.showErrorBox('PixelForge Studio could not start', `${error.message}\n\nLog: ${logPath}`); });
  win.on('unresponsive', () => log('ERROR', 'Window became unresponsive'));
  win.on('close', event => {
    if (closeAuthorized) return;
    event.preventDefault();
    if (!closePromptPending) {
      closePromptPending = true;
      win.webContents.send('pf:close-request');
      log('INFO', 'Renderer asked to confirm unsaved document changes before closing');
    }
  });
  win.on('closed', () => { log('INFO', 'Window closed'); win = null; });
}

app.whenReady().then(() => {
  logPath = path.join(app.getPath('userData'), 'logs', 'main.log');
  require('node:fs').mkdirSync(path.dirname(logPath), { recursive: true });
  log('INFO', 'Application ready', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, userData: app.getPath('userData') });
  Menu.setApplicationMenu(null);
  const prefsPath = path.join(app.getPath('userData'), 'workspace.json');
  ipcMain.handle('pf:open', async (event) => { try { assertTrustedMainFrame(event); const result = await dialog.showOpenDialog(win, { title: 'Open image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp','bmp','gif','tif','tiff'] }] }); if (result.canceled || !result.filePaths[0]) return null; const filePath=result.filePaths[0],stat=await fs.stat(filePath); if(!stat.isFile()||stat.size<1||stat.size>MAX_DROPPED_IMAGE_BYTES)throw new Error('Images must be 100 MB or smaller.'); log('INFO', 'Image opened', { filePath, bytes: stat.size }); return { path: filePath, data: await fs.readFile(filePath, 'base64') }; } catch (error) { log('ERROR', 'Open image IPC failed', error); throw error; } });
  ipcMain.handle('pf:openProject', async event => {
    try {
      assertTrustedMainFrame(event);
      const result = await dialog.showOpenDialog(win, { title: 'Open PixelForge project', properties: ['openFile'], filters: [{ name: 'PixelForge Studio project', extensions: ['pforge'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      return await readProjectFile(result.filePaths[0]);
    } catch (error) { log('ERROR', 'Open project IPC failed', error); throw error; }
  });
  ipcMain.handle('pf:dropProject', async (event, candidatePath) => {
    try {
      assertTrustedMainFrame(event);
      if (typeof candidatePath !== 'string' || candidatePath.length > 32768) throw new Error('The dropped project path is invalid.');
      return await readProjectFile(path.resolve(candidatePath));
    } catch (error) { log('ERROR', 'Dropped project IPC failed', error); throw error; }
  });
  ipcMain.handle('pf:saveProject', async (event, request) => {
    try {
      assertTrustedMainFrame(event);
      let filePath = typeof request?.existingPath === 'string' && request.existingPath.toLowerCase().endsWith('.pforge') && request.saveAs !== true ? path.resolve(request.existingPath) : undefined;
      if (!filePath) {
        const base = typeof request?.suggestedName === 'string' ? path.basename(request.suggestedName).replace(/[^\w .()\-]/g, '_') : 'Untitled.pforge';
        const suggested = base.toLowerCase().endsWith('.pforge') ? base : `${base.replace(/\.[^.]+$/, '')}.pforge`;
        const result = await dialog.showSaveDialog(win, { title: 'Save PixelForge project', defaultPath: suggested, filters: [{ name: 'PixelForge Studio project', extensions: ['pforge'] }] });
        if (result.canceled || !result.filePath) return null;
        filePath = result.filePath.toLowerCase().endsWith('.pforge') ? result.filePath : `${result.filePath}.pforge`;
      }
      const savedPath = await writeProjectFile(filePath, request);
      return { path: savedPath };
    } catch (error) { log('ERROR', 'Save project IPC failed', error); throw error; }
  });
  ipcMain.handle('pf:allowClose', async event => {
    assertTrustedMainFrame(event);
    closeAuthorized = true; closePromptPending = false;
    if (win && !win.isDestroyed()) win.close();
    return true;
  });
  ipcMain.handle('pf:cancelClose', async event => {
    assertTrustedMainFrame(event);
    closePromptPending = false;
    return true;
  });
  ipcMain.handle('pf:dropImage', async (event, candidatePath) => {
    try {
      if (!isTrustedMainFrame(event)) throw new Error('Image import request came from an untrusted renderer');
      if (typeof candidatePath !== 'string' || candidatePath.length > 32768) throw new Error('The dropped file path is invalid');
      const filePath = path.resolve(candidatePath);
      const extension = path.extname(filePath).toLowerCase();
      const mimeType = droppedImageTypes[extension];
      if (!mimeType) throw new Error('Unsupported image type. Use PNG, JPEG, WebP, BMP or GIF.');
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('The dropped item is not a file');
      if (stat.size === 0) throw new Error('The dropped image file is empty');
      if (stat.size > MAX_DROPPED_IMAGE_BYTES) throw new Error('Images must be smaller than 100 MB.');
      const data = await fs.readFile(filePath, 'base64');
      log('INFO', 'Image dropped into document', { name: path.basename(filePath), bytes: stat.size });
      return { name: path.basename(filePath), mimeType, data };
    } catch (error) {
      log('ERROR', 'Dropped image IPC failed', error);
      throw error;
    }
  });
  ipcMain.handle('pf:save', async (event, { suggestedName, data, format = 'png' }) => {
    try {
      assertTrustedMainFrame(event);
      const result = await dialog.showSaveDialog(win, { title: 'Export image', defaultPath: suggestedName || 'Untitled.png', filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (result.canceled || !result.filePath) return null;
      await writeBufferAtomically(result.filePath, Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      log('INFO', 'Image saved', result.filePath);
      return result.filePath;
    } catch (error) { log('ERROR', 'Save image IPC failed', error); throw error; }
  });
  ipcMain.handle('pf:readPrefs', async (event) => { try { assertTrustedMainFrame(event); const prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8')); log('INFO', 'Workspace preferences read', prefs); return prefs; } catch (error) { if (error.code !== 'ENOENT') log('ERROR', 'Read preferences IPC failed', error); return {}; } });
  ipcMain.handle('pf:writePrefs', async (event, prefs) => { try { assertTrustedMainFrame(event); await fs.mkdir(path.dirname(prefsPath), { recursive: true }); await fs.writeFile(prefsPath, JSON.stringify(prefs)); return true; } catch (error) { log('ERROR', 'Write preferences IPC failed', error); throw error; } });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { log('ERROR', 'Application startup failed', error); dialog.showErrorBox('PixelForge Studio startup error', `${error.stack || error}\n\nLog: ${logPath || 'unavailable'}`); app.quit(); });
app.on('window-all-closed', () => { log('INFO', 'All windows closed'); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (!closeAuthorized && win && !win.isDestroyed()) { event.preventDefault(); win.close(); return; }
  log('INFO', 'Application exiting');
});
