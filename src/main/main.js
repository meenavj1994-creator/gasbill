'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { migrate } = require('./migrations');
const { createRepository } = require('./repository');
const gst = require('../shared/gst');
const { seedCharges } = require('./seed');
const { parseCertificate } = require('./certificate');
const reports = require('./reports');
const { extractText } = require('./extract');
const XLSX = require('xlsx');
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

function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.on('update-downloaded', function (info) {
    if (win) win.webContents.send('update:ready', info.version);
  });
  autoUpdater.on('error', function (err) {
    console.error('update check failed:', err.message);
  });
  autoUpdater.checkForUpdates().catch(function (err) {
    console.error('update check failed:', err.message);
  });
}

app.whenReady().then(function () {
  openDatabase();
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

handle('distributor:get', function () { return repo.getDistributor(); });
handle('distributor:save', function (d) { return repo.saveDistributor(d); });

handle('charges:active', function () { return repo.activeCharges(); });
handle('charges:all', function () { return repo.allCharges(); });
handle('charges:add', function (c) { return repo.addCharge(c); });
handle('charges:revise', function (id, next) { return repo.reviseCharge(id, next); });

handle('consumers:find', function (no) { return repo.findConsumer(no); });
handle('consumers:search', function (query, limit) { return repo.searchConsumers(query, limit); });
handle('consumers:import', function (rows) { return repo.importConsumers(rows); });

handle('invoice:preview', function (date) { return repo.nextInvoicePreview(date); });
handle('invoice:save', function (payload) { return repo.saveInvoice(payload); });
handle('invoice:get', function (id) { return repo.getInvoice(id); });
handle('invoice:between', function (from, to) { return repo.invoicesBetween(from, to); });

handle('gstin:validate', function (value, stateCode) { return gst.validateGstin(value, stateCode); });
handle('compute', function (lines, supplierState, posCode) {
  return gst.computeInvoice(lines, supplierState, posCode);
});

handle('consumers:parseFile', function (filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers: headers, rows: rows };
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

handle('reports:export', function (from, to, targetPath) {
  const invoices = repo.invoicesBetween(from, to);
  const notes = db.prepare(`SELECT n.*, i.invoice_no FROM credit_notes n
    JOIN invoices i ON i.id = n.invoice_id
    WHERE n.note_date BETWEEN ? AND ? ORDER BY n.note_date`).all(from, to);
  const wb = reports.buildWorkbook(XLSX, { invoices: invoices, creditNotes: notes });
  XLSX.writeFile(wb, targetPath);
  return { path: targetPath, invoices: invoices.length };
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

ipcMain.handle('print:invoice', function () {
  win.webContents.print({ silent: false, printBackground: true });
  return { ok: true };
});

ipcMain.handle('update:install', function () {
  autoUpdater.quitAndInstall();
});

ipcMain.on('app:dirty', function (event, isDirty) { dirty = isDirty; });
