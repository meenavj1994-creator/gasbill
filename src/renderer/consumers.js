'use strict';

const $ = function (id) { return document.getElementById(id); };
let parsed = null;

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const GUESSES = {
  'm-no': ['consumer_no', 'consumerno', 'consumer no', 'consumer number', 'cons_no', 'cust_no'],
  'm-name': ['cons_name', 'consumer name', 'name', 'customer name', 'consumer_name'],
  'm-address': ['address1', 'address', 'addr', 'address_1'],
  'm-mobile': ['mobile_no', 'mobile', 'phone', 'contact', 'mobile number']
};

function guessColumn(headers, id) {
  const wanted = GUESSES[id];
  for (const w of wanted) {
    const hit = headers.find(function (h) {
      return h.toLowerCase().replace(/[^a-z0-9]/g, '') === w.replace(/[^a-z0-9]/g, '');
    });
    if (hit) return hit;
  }
  for (const w of wanted) {
    const hit = headers.find(function (h) { return h.toLowerCase().indexOf(w) >= 0; });
    if (hit) return hit;
  }
  return '';
}

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

  $('file-info').textContent = parsed.rows.length.toLocaleString('en-IN') + ' rows found.';
  $('file-info').className = 'hint ok';

  Object.keys(GUESSES).forEach(function (id) {
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
    select.value = guessColumn(parsed.headers, id);
  });

  $('mapping').hidden = false;
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
