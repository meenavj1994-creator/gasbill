'use strict';

const $ = function (id) { return document.getElementById(id); };

let distributor = null;
let logoPath = null;
let backupFolder = null;

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function toast(message, kind) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast toast-in' + (kind ? ' toast-' + kind : '');
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () {
    el.className = 'toast';
    setTimeout(function () { el.hidden = true; }, 200);
  }, 3200);
}

function toFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

function setLogo(path) {
  logoPath = path;
  $('logo-preview').src = toFileUrl(path);
  $('logo-preview').hidden = false;
}

async function load() {
  distributor = await unwrap(window.api.distributor.get());
  if (!distributor || !distributor.setup_complete) {
    window.location.href = 'setup.html';
    return;
  }

  $('gstin').value = distributor.gstin || '';
  $('trade-name').value = distributor.trade_name || '';
  $('legal-name').value = distributor.legal_name || '';
  $('address').value = distributor.address || '';
  $('phone').value = distributor.phone || '';
  $('prefix').value = distributor.series_prefix || '';
  $('ack').value = distributor.ack_text || '';
  $('tagline').value = distributor.tagline || '';
  $('jurisdiction').value = distributor.jurisdiction || '';

  if (distributor.logo_path) setLogo(distributor.logo_path);

  backupFolder = distributor.backup_folder || null;
  $('backup').value = backupFolder || '';

  const last = await unwrap(window.api.backup.last());
  $('backup-status').textContent = last
    ? 'Last backup ' + last.created_at.slice(0, 10) + '.'
    : 'No backup has run yet.';

  $('version-tag').textContent = 'v' + (await unwrap(window.api.appVersion()));
  await previewNumber();
}

async function checkGstin() {
  const raw = $('gstin').value.trim().toUpperCase();
  const out = $('gstin-result');
  if (!raw) { out.textContent = ''; out.className = 'hint'; return false; }

  const r = await unwrap(window.api.validateGstin(raw, distributor.state_code));
  if (r.valid) {
    $('gstin').value = r.gstin;
    out.textContent = 'Checks out.';
    out.className = 'hint ok';
    return true;
  }
  out.textContent = r.reason;
  out.className = 'hint bad';
  return false;
}

async function previewNumber() {
  const prefix = $('prefix').value.trim().toUpperCase();
  if (!prefix) {
    $('prefix-preview').textContent = '';
    $('prefix-error').hidden = true;
    return false;
  }

  const result = await window.api.gst.sampleInvoiceNo(prefix, new Date().toISOString());
  if (!result.ok) {
    $('prefix-preview').textContent = '';
    $('prefix-error').textContent = result.error;
    $('prefix-error').hidden = false;
    return false;
  }

  $('prefix-preview').textContent = 'Next month starts at ' + result.data + '.';
  $('prefix-error').hidden = true;
  return true;
}

$('gstin').addEventListener('blur', checkGstin);
$('gstin').addEventListener('input', function () {
  $('gstin-result').textContent = '';
  $('gstin-result').className = 'hint';
});

$('prefix').addEventListener('input', previewNumber);

$('logo-file').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (file) setLogo(window.api.pathOf(file));
});

$('pick-backup').addEventListener('click', async function () {
  const folder = await window.api.pickFolder();
  if (folder) {
    backupFolder = folder;
    $('backup').value = folder;
  }
});

['trade-name', 'address'].forEach(function (id) {
  $(id).addEventListener('input', function () { $(id + '-error').hidden = true; });
});

$('save').addEventListener('click', async function () {
  let valid = true;

  if (!$('trade-name').value.trim()) {
    $('trade-name-error').textContent = 'Enter the trade name.';
    $('trade-name-error').hidden = false;
    valid = false;
  }
  if (!$('address').value.trim()) {
    $('address-error').textContent = 'Enter the address.';
    $('address-error').hidden = false;
    valid = false;
  }
  if (!(await previewNumber())) valid = false;
  if (!(await checkGstin())) valid = false;
  if (!valid) return;

  /* saveDistributor writes every column, so carry across the fields this
     screen does not edit rather than letting them fall to null. */
  await unwrap(window.api.distributor.save({
    trade_name: $('trade-name').value.trim(),
    legal_name: $('legal-name').value.trim() || null,
    address: $('address').value.trim(),
    gstin: $('gstin').value.trim().toUpperCase(),
    state_code: distributor.state_code,
    phone: $('phone').value.trim() || null,
    logo_path: logoPath,
    certificate_path: distributor.certificate_path,
    series_prefix: $('prefix').value.trim().toUpperCase(),
    ack_text: $('ack').value.trim() || null,
    tagline: $('tagline').value.trim() || null,
    jurisdiction: $('jurisdiction').value.trim() || null,
    backup_folder: backupFolder,
    setup_complete: 1
  }));

  distributor = await unwrap(window.api.distributor.get());
  toast('Saved', 'ok');
});

load().catch(function (err) {
  document.body.innerHTML = '<p style="padding:24px;color:#A32D2D">Could not load settings: ' + err.message + '</p>';
});
