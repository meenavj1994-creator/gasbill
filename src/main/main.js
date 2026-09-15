'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { migrate } = require('./migrations');
const { createRepository } = require('./repository');
const gst = require('../shared/gst');
const { seedCharges, seedBundles } = require('./seed');
const { parseCertificate } = require('./certificate');
const reports = require('./reports');
const { extractText } = require('./extract');
const XLSX = require('xlsx');
const tabular = require('./tabular');
const { autoUpdater } = require('electron-updater');

let db;
let repo;
let win;
let dirty = false;

function dbPath() {
  return path.join(app.getPath('userData'), 'invoices.db');
}

function openDatabase() {
  db = new Database(dbPath());
  migrate(db);
  repo = createRepository(db);
  seedCharges(repo);
  seedBundles(repo);
}

function runBackup() {
  const d = repo.getDistributor();
  if (!d || !d.backup_folder) return;
  try {
    if (!fs.existsSync(d.backup_folder)) fs.mkdirSync(d.backup_folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(d.backup_folder, 'invoices-' + stamp + '.db');
    db.prepare('VACUUM INTO ?').run(target);
    db.prepare('INSERT INTO backups (path, created_at) VALUES (?, ?)').run(target, new Date().toISOString());

    const kept = db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
    for (const old of kept.slice(30)) {
      try { fs.unlinkSync(old.path); } catch (e) { /* already gone */ }
      db.prepare('DELETE FROM backups WHERE id = ?').run(old.id);
    }
    return target;
  } catch (err) {
    console.error('backup failed:', err.message);
    return null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'GasBill',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('did-navigate', function () { dirty = false; });

  win.on('close', function (event) {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have an unsaved invoice.',
      detail: 'Closing now will lose it — there is no draft recovery.'
    });
    if (choice === 1) event.preventDefault();
  });
}

let pendingUpdateVersion = null;
let updaterWired = false;

function wireUpdater() {
  if (updaterWired) return;
  updaterWired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', function (info) {
    pendingUpdateVersion = info.version;
    if (win) win.webContents.send('update:ready', info.version);
  });
  autoUpdater.on('error', function (err) {
    console.error('update check failed:', err.message);
  });
}

function checkForUpdates() {
  if (!app.isPackaged) return;
  wireUpdater();
  autoUpdater.checkForUpdates().catch(function (err) {
    console.error('update check failed:', err.message);
  });
}

async function checkForUpdatesInteractive() {
  if (!app.isPackaged) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Updates are only checked in the installed app.',
      detail: 'This is a development build.',
      buttons: ['OK']
    });
    return;
  }

  wireUpdater();
  try {
    const result = await autoUpdater.checkForUpdates();
    const found = result && result.updateInfo ? result.updateInfo.version : null;

    if (pendingUpdateVersion) {
      dialog.showMessageBox(win, {
        type: 'info',
        message: 'Version ' + pendingUpdateVersion + ' is ready to install.',
        detail: 'Use the "Restart to update" button on the billing screen.',
        buttons: ['OK']
      });
    } else if (found && found !== app.getVersion()) {
      dialog.showMessageBox(win, {
        type: 'info',
        message: 'Version ' + found + ' is downloading in the background.',
        detail: 'A "Restart to update" banner appears once it is ready.',
        buttons: ['OK']
      });
    } else {
      dialog.showMessageBox(win, {
        type: 'info',
        message: 'GasBill is up to date.',
        detail: 'Version ' + app.getVersion(),
        buttons: ['OK']
      });
    }
  } catch (err) {
    dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Could not check for updates.',
      detail: err.message,
      buttons: ['OK']
    });
  }
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'About GasBill',
    message: 'GasBill ' + app.getVersion(),
    detail: 'Offline GST tax invoicing for LPG distributors.',
    buttons: ['OK']
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit', label: 'Exit' }]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for updates…', click: checkForUpdatesInteractive },
        { type: 'separator' },
        { label: 'About GasBill', click: showAbout }
      ]
    }
  ]));
}

/* Preview PDFs are deleted when their window closes; anything left behind
   by a crash or a kill is swept here. */
function sweepPrintTemp() {
  const dir = path.join(app.getPath('temp'), 'gasbill-print');
  try {
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* in use */ }
    }
  } catch (e) { /* no folder yet */ }
}

app.whenReady().then(function () {
  sweepPrintTemp();
  openDatabase();
  buildMenu();
  createWindow();
  checkForUpdates();
});

app.on('before-quit', function () {
  runBackup();
  if (db) db.close();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

function handle(channel, fn) {
  ipcMain.handle(channel, function (event) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      return { ok: true, data: fn.apply(null, args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

/* A distributor set up before the logo picker existed has no logo_path.
   The bundled Bharatgas mark is the right default for this app, so it is
   filled in here rather than printing a blank. Settings still lets them
   pick their own. */
function defaultLogoPath() {
  const p = path.join(__dirname, '..', '..', 'resources', 'branding', 'bharatgas-logo.png');
  return fs.existsSync(p) ? p : null;
}
handle('distributor:get', function () {
  const d = repo.getDistributor();
  if (d && !d.logo_path) d.logo_path = defaultLogoPath();
  if (d) d.state_name = gst.stateName(d.state_code) || d.state_code;
  return d;
});
handle('gst:stateName', function (code) { return gst.stateName(code); });
handle('distributor:save', function (d) { return repo.saveDistributor(d); });

handle('app:version', function () { return app.getVersion(); });

handle('gst:seriesPrefix', function (tradeName) { return gst.seriesPrefix(tradeName); });
handle('gst:sampleInvoiceNo', function (prefix, iso) {
  return gst.buildInvoiceNumber(prefix, iso ? new Date(iso) : new Date(), 1);
});

handle('branding:defaultLogo', function () { return defaultLogoPath(); });

handle('charges:active', function () { return repo.activeCharges(); });
handle('charges:all', function () { return repo.allCharges(); });
handle('charges:add', function (c) { return repo.addCharge(c); });
handle('charges:codeHints', function () { return require('./seed').CODE_HINTS; });
handle('charges:revise', function (id, next) { return repo.reviseCharge(id, next); });

handle('bundles:list', function () { return repo.listBundles(); });
handle('bundles:save', function (b) { return repo.saveBundle(b); });
handle('bundles:delete', function (id) { return repo.deleteBundle(id); });
handle('bundles:resolve', function (id) { return repo.resolveBundle(id); });

handle('consumers:find', function (no) { return repo.findConsumer(no); });
handle('consumers:search', function (query, limit) { return repo.searchConsumers(query, limit); });
handle('consumers:import', function (rows) { return repo.importConsumers(rows); });

handle('invoice:preview', function (date) { return repo.nextInvoicePreview(date); });
handle('invoice:save', function (payload) { return repo.saveInvoice(payload); });
handle('invoice:get', function (id) { return repo.getInvoice(id); });
handle('invoice:list', function (filter) { return repo.listInvoices(filter); });
handle('invoice:delete', function (id) { return repo.deleteInvoice(id); });
handle('invoice:replace', function (id, payload) { return repo.replaceInvoice(id, payload); });
handle('invoice:between', function (from, to) { return repo.invoicesBetween(from, to); });

handle('gstin:validate', function (value, stateCode) { return gst.validateGstin(value, stateCode); });
handle('compute', function (lines, supplierState, posCode, discount) {
  return gst.computeInvoice(lines, supplierState, posCode, discount);
});
handle('taxBreakup', function (lines, intraState) {
  return gst.taxBreakupFromLines(lines, intraState);
});

handle('consumers:parseFile', function (filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // As a matrix, not objects: sheet_to_json would take row 1 as the header,
  // and a portal export usually opens with a title and a blank row or two.
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true });
  return tabular.readMatrix(matrix);
});

ipcMain.handle('certificate:read', async function (event, filePath, expectedStateCode) {
  try {
    const extracted = await extractText(filePath);
    if (!extracted.text) {
      return {
        ok: true,
        data: {
          ok: false,
          reason: 'Could not read any text from that file' +
            (extracted.error ? ' (' + extracted.error + ')' : '') +
            '. Enter the details manually.',
          fields: {}
        }
      };
    }
    const parsed = parseCertificate(extracted.text, { expectedStateCode: expectedStateCode });
    parsed.method = extracted.method;
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* Reads invoices out of another machine's database file. Opened strictly
   read-only and never migrated — this is usually someone's backup, and a
   report must not be able to write to it. */
function invoicesFromFile(filePath, from, to) {
  const other = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const rows = other.prepare(`SELECT * FROM invoices WHERE invoice_date BETWEEN ? AND ?
      ORDER BY invoice_date, id`).all(from, to);
    for (const r of rows) {
      r.lines = other.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(r.id);
    }
    const label = (other.prepare('SELECT trade_name, series_prefix FROM distributor WHERE id = 1').get() || {});
    const notes = other.prepare(`SELECT n.*, i.invoice_no FROM credit_notes n
      JOIN invoices i ON i.id = n.invoice_id
      WHERE n.note_date BETWEEN ? AND ? ORDER BY n.note_date`).all(from, to);
    return { rows: rows, notes: notes, source: label.series_prefix || path.basename(filePath) };
  } finally {
    other.close();
  }
}

handle('reports:period', function (which, iso) {
  const when = iso ? new Date(iso) : new Date();
  return which === 'month'
    ? reports.periodForMonth(when)
    : reports.periodForFinancialYear(when);
});

handle('reports:export', function (from, to, targetPath, extraPaths) {
  const sets = [{
    source: (repo.getDistributor() || {}).series_prefix || 'this machine',
    invoices: repo.invoicesBetween(from, to)
  }];
  let notes = db.prepare(`SELECT n.*, i.invoice_no FROM credit_notes n
    JOIN invoices i ON i.id = n.invoice_id
    WHERE n.note_date BETWEEN ? AND ? ORDER BY n.note_date`).all(from, to);

  const merged = [];
  for (const p of extraPaths || []) {
    const other = invoicesFromFile(p, from, to);
    sets.push({ source: other.source, invoices: other.rows });
    notes = notes.concat(other.notes);
    merged.push(other.source);
  }

  const combined = reports.mergeInvoices(sets);
  const wb = reports.buildWorkbook(XLSX, {
    invoices: combined.invoices,
    creditNotes: notes,
    duplicates: combined.duplicates
  });
  XLSX.writeFile(wb, targetPath);
  return {
    path: targetPath,
    invoices: combined.invoices.length,
    merged: merged,
    duplicates: combined.duplicates.length
  };
});

handle('backup:run', function () { return runBackup(); });
handle('backup:last', function () {
  return db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1').get() || null;
});

ipcMain.handle('dialog:saveWorkbook', async function (event, suggested) {
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggested,
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:pickFolder', async function () {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

/* Electron has no print preview of its own: webContents.print() goes straight
   to the Windows printer dialog, so the user commits to paper without seeing
   the page. Instead the invoice is rendered to a PDF and shown in a preview
   window — Chromium's PDF viewer, which carries its own Print and Save
   buttons — so what prints is exactly what was looked at. The file is named
   after the invoice so "Save" suggests something sensible, and is removed
   when the window closes. */
ipcMain.handle('print:invoice', async function (event, label) {
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true
  });
  const safe = String(label || 'invoice').replace(/[^A-Za-z0-9._-]+/g, '-');
  const dir = path.join(app.getPath('temp'), 'gasbill-print');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe + '.pdf');
  fs.writeFileSync(file, pdf);

  const preview = new BrowserWindow({
    parent: win,
    width: 900,
    height: Math.min(1100, Math.max(700, win.getBounds().height)),
    title: 'Print — ' + (label || 'invoice'),
    autoHideMenuBar: true,
    backgroundColor: '#525659'
  });
  preview.setMenuBarVisibility(false);
  // The PDF viewer would otherwise rename the window after the file.
  preview.on('page-title-updated', function (e) { e.preventDefault(); });
  preview.loadURL(require('url').pathToFileURL(file).href);
  preview.on('closed', function () {
    fs.unlink(file, function () { /* best effort */ });
  });
  return { ok: true };
});

ipcMain.handle('update:install', function () {
  autoUpdater.quitAndInstall();
});

handle('update:pending', function () { return pendingUpdateVersion; });

ipcMain.on('app:dirty', function (event, isDirty) { dirty = isDirty; });
