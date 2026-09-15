'use strict';

const $ = function (id) { return document.getElementById(id); };
let parsed = null;

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/* The main process finds the header row and works out which column holds
   which field — see tabular.js. This file only shows what it decided and
   lets it be overridden. */
const FIELD_OF = {
  'm-no': 'consumer_no',
  'm-name': 'name',
  'm-address': 'address',
  'm-mobile': 'mobile'
};

$('file').addEventListener('change', async function (e) {
  const file = e.target.files[0];
  if (!file) return;
  $('result').hidden = true;

  try {
    parsed = await unwrap(window.api.consumers.parseFile(window.api.pathOf(file)));
  } catch (err) {
    $('file-info').textContent = 'Could not read the file: ' + err.message;
    $('file-info').className = 'hint bad';
    return;
  }

  if (!parsed.headers.length || !parsed.rows.length) {
    $('file-info').textContent = 'No rows found in that file.';
    $('file-info').className = 'hint bad';
    $('mapping').hidden = true;
    return;
  }

  const where = parsed.headerRow > 1
    ? ' Column headings found in row ' + parsed.headerRow + '.'
    : (parsed.headerRow < 0 ? ' No heading row found, so columns are named by letter — pick them below.' : '');
  $('file-info').textContent = parsed.rows.length.toLocaleString('en-IN') + ' rows found.' + where;
  $('file-info').className = parsed.headerRow < 0 ? 'hint' : 'hint ok';

  Object.keys(FIELD_OF).forEach(function (id) {
    const select = $(id);
    select.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = id === 'm-address' || id === 'm-mobile' ? 'Not in this file' : 'Choose a column…';
    select.appendChild(blank);

    for (const h of parsed.headers) {
      const option = document.createElement('option');
      option.value = h;
      option.textContent = h;
      select.appendChild(option);
    }
    select.value = (parsed.guess && parsed.guess[FIELD_OF[id]]) || '';
  });

  const missing = ['m-no', 'm-name'].filter(function (id) { return !$(id).value; });
  if (missing.length) {
    $('map-error').textContent = 'Could not tell which columns hold the consumer number and name. Pick them below.';
    $('map-error').hidden = false;
  } else {
    $('map-error').hidden = true;
  }

  $('mapping').hidden = false;
  renderPreview();
});

/* The mapping was guessed, so show what it produces before anything is
   written. Three rows is enough to catch a column off by one. */
function renderPreview() {
  const body = $('preview-rows');
  body.innerHTML = '';
  const cols = ['m-no', 'm-name', 'm-address', 'm-mobile'].map(function (id) { return $(id).value; });
  for (const row of (parsed ? parsed.rows.slice(0, 3) : [])) {
    const tr = document.createElement('tr');
    for (const col of cols) {
      const td = document.createElement('td');
      td.textContent = col ? String(row[col] || '') : '—';
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

['m-no', 'm-name', 'm-address', 'm-mobile'].forEach(function (id) {
  $(id).addEventListener('change', renderPreview);
});

$('run').addEventListener('click', async function () {
  const noCol = $('m-no').value;
  const nameCol = $('m-name').value;

  if (!noCol || !nameCol) {
    $('map-error').textContent = 'Pick the consumer number and name columns.';
    $('map-error').hidden = false;
    return;
  }
  $('map-error').hidden = true;

  const addressCol = $('m-address').value;
  const mobileCol = $('m-mobile').value;

  const rows = parsed.rows.map(function (row) {
    return {
      consumer_no: row[noCol],
      name: row[nameCol],
      address: addressCol ? row[addressCol] : null,
      mobile: mobileCol ? row[mobileCol] : null
    };
  });

  const result = await unwrap(window.api.consumers.import(rows));
  $('r-created').textContent = result.created.toLocaleString('en-IN');
  $('r-updated').textContent = result.updated.toLocaleString('en-IN');
  $('r-skipped').textContent = result.skipped.toLocaleString('en-IN');
  $('result').hidden = false;
});
