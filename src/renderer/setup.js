'use strict';

const $ = function (id) { return document.getElementById(id); };
const STATE_CODE = '23';
let backupFolder = null;
let logoPath = null;

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function toFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

function setLogo(path) {
  logoPath = path;
  $('logo-preview').src = toFileUrl(path);
  $('logo-preview').hidden = false;
}

(async function loadDefaultLogo() {
  const def = await unwrap(window.api.branding.defaultLogo());
  if (def) setLogo(def);
})();

$('logo-file').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (file) setLogo(window.api.pathOf(file));
});

$('cert-file').addEventListener('change', async function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const out = $('cert-result');
  out.textContent = 'Reading…';
  out.className = 'hint';

  try {
    const parsed = await unwrap(window.api.certificate.read(window.api.pathOf(file), STATE_CODE));
    if (!parsed.ok) {
      out.textContent = parsed.reason;
      out.className = 'hint bad';
      return;
    }
    if (parsed.fields.gstin) $('gstin').value = parsed.fields.gstin;
    if (parsed.fields.trade_name) {
      $('trade-name').value = parsed.fields.trade_name;
      $('trade-name').dispatchEvent(new Event('input'));
    }
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

  $('prefix-preview').textContent = 'Invoices will be numbered ' + result.data +
    ', restarting at 0001 each month.';
  $('prefix-error').hidden = true;
  return true;
}

/* The prefix follows the trade name until the user types their own. */
let prefixTouched = false;
$('prefix').addEventListener('input', function () {
  prefixTouched = true;
  previewNumber();
});

$('trade-name').addEventListener('input', async function () {
  if (prefixTouched) return;
  $('prefix').value = await unwrap(window.api.gst.seriesPrefix($('trade-name').value));
  previewNumber();
});

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
  if (!(await previewNumber())) valid = false;
  if (!(await checkGstin())) valid = false;
  if (!valid) return;

  await unwrap(window.api.distributor.save({
    trade_name: $('trade-name').value.trim(),
    legal_name: $('legal-name').value.trim() || null,
    address: $('address').value.trim(),
    gstin: $('gstin').value.trim().toUpperCase(),
    state_code: STATE_CODE,
    phone: $('phone').value.trim() || null,
    logo_path: logoPath,
    certificate_path: window.api.pathOf($('cert-file').files[0]),
    series_prefix: $('prefix').value.trim().toUpperCase() ||
      await unwrap(window.api.gst.seriesPrefix($('trade-name').value)),
    ack_text: $('ack').value.trim() || null,
    backup_folder: backupFolder,
    setup_complete: 1
  }));

  window.location.href = 'index.html';
});
