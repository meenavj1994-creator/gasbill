'use strict';

const $ = function (id) { return document.getElementById(id); };
const STATE_CODE = '23';
let backupFolder = null;

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

$('cert-file').addEventListener('change', async function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const out = $('cert-result');
  out.textContent = 'Reading…';
  out.className = 'hint';

  try {
    const parsed = await unwrap(window.api.certificate.read(file.path, STATE_CODE));
    if (!parsed.ok) {
      out.textContent = parsed.reason;
      out.className = 'hint bad';
      return;
    }
    if (parsed.fields.gstin) $('gstin').value = parsed.fields.gstin;
    if (parsed.fields.trade_name) $('trade-name').value = parsed.fields.trade_name;
    if (parsed.fields.legal_name) $('legal-name').value = parsed.fields.legal_name;
    if (parsed.fields.address) $('address').value = parsed.fields.address;

    out.textContent = parsed.missing.length
      ? 'Read from the certificate. Could not find: ' + parsed.missing.join(', ') + '. Check every field, especially the GSTIN.'
      : 'Read from the certificate. Check every field against it, especially the GSTIN.';
    out.className = 'hint ok';
    await checkGstin();
  } catch (err) {
    out.textContent = 'Could not read the file: ' + err.message;
    out.className = 'hint bad';
  }
});

async function checkGstin() {
  const raw = $('gstin').value.trim().toUpperCase();
  const out = $('gstin-result');
  if (!raw) { out.textContent = ''; out.className = 'hint'; return false; }

  const r = await unwrap(window.api.validateGstin(raw, STATE_CODE));
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

$('gstin').addEventListener('blur', checkGstin);
$('gstin').addEventListener('input', function () {
  $('gstin-result').textContent = '';
  $('gstin-result').className = 'hint';
});

function previewNumber() {
  const prefix = $('prefix').value.trim().toUpperCase() || 'BG';
  const year = new Date();
  const startYear = year.getMonth() >= 3 ? year.getFullYear() : year.getFullYear() - 1;
  const label = String(startYear % 100).padStart(2, '0') + String((startYear + 1) % 100).padStart(2, '0');
  const sample = prefix + '/' + label + '/00001';

  $('prefix-preview').textContent = 'Invoices will be numbered ' + sample;
  if (sample.length > 16) {
    $('prefix-error').textContent = 'That prefix makes the number ' + sample.length + ' characters. The limit is 16.';
    $('prefix-error').hidden = false;
    return false;
  }
  $('prefix-error').hidden = true;
  return true;
}

$('prefix').addEventListener('input', previewNumber);
previewNumber();

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

$('finish').addEventListener('click', async function () {
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
  if (!previewNumber()) valid = false;
  if (!(await checkGstin())) valid = false;
  if (!valid) return;

  await unwrap(window.api.distributor.save({
    trade_name: $('trade-name').value.trim(),
    legal_name: $('legal-name').value.trim() || null,
    address: $('address').value.trim(),
    gstin: $('gstin').value.trim().toUpperCase(),
    state_code: STATE_CODE,
    phone: $('phone').value.trim() || null,
    logo_path: null,
    certificate_path: $('cert-file').files[0] ? $('cert-file').files[0].path : null,
    series_prefix: $('prefix').value.trim().toUpperCase() || 'BG',
    ack_text: $('ack').value.trim() || null,
    backup_folder: backupFolder,
    setup_complete: 1
  }));

  window.location.href = 'index.html';
});
