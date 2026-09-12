'use strict';

const $ = function (id) { return document.getElementById(id); };

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/* The ranges are worked out in the main process rather than here. This file
   used to build them with toISOString(), which converts a local midnight to
   UTC and rolls it back a day in any zone ahead of it — the financial year
   came out as 31 Mar to 30 Mar, quietly dropping the last day of the year
   from the return. gst.js owns the dates and is tested on exactly that. */
async function currentRange() {
  const preset = $('preset').value;
  if (preset === 'custom') {
    return { from: $('from').value, to: $('to').value, label: 'custom' };
  }
  const period = await unwrap(window.api.reports.period(preset, new Date().toISOString()));
  return {
    from: period.from,
    to: period.to,
    label: preset === 'fy' ? 'FY' + period.label : period.label
  };
}

async function describe() {
  const r = await currentRange();
  $('range-note').textContent = r.from && r.to ? r.from + ' to ' + r.to : '';
}

$('preset').addEventListener('change', function () {
  $('custom-range').hidden = $('preset').value !== 'custom';
  describe();
});
$('from').addEventListener('change', describe);
$('to').addEventListener('change', describe);
describe();

let otherDbs = [];

$('other-dbs').addEventListener('change', function (e) {
  otherDbs = Array.prototype.slice.call(e.target.files).map(function (f) { return window.api.pathOf(f); });
  $('others-picked').textContent = otherDbs.length
    ? otherDbs.length + ' other machine' + (otherDbs.length > 1 ? 's' : '') + ' will be merged in.'
    : '';
  $('others-picked').className = otherDbs.length ? 'hint ok' : 'hint';
});

$('export').addEventListener('click', async function () {
  const range = await currentRange();
  if (!range.from || !range.to) {
    $('error').textContent = 'Pick both dates.';
    $('error').hidden = false;
    return;
  }
  if (range.from > range.to) {
    $('error').textContent = 'The from date is after the to date.';
    $('error').hidden = false;
    return;
  }
  $('error').hidden = true;

  const target = await window.api.saveWorkbook('gst-' + range.label + '.xlsx');
  if (!target) return;

  try {
    const result = await unwrap(
      window.api.reports.export(range.from, range.to, target, otherDbs));

    let note = result.invoices + ' invoices exported to ' + result.path;
    if (result.merged.length) note += ' (merged: ' + result.merged.join(', ') + ')';
    $('range-note').textContent = note;
    $('range-note').className = 'hint ok';

    if (result.duplicates) {
      $('error').textContent = result.duplicates + ' invoice number' +
        (result.duplicates > 1 ? 's were' : ' was') + ' issued on more than one machine. ' +
        'See the DUPLICATE NUMBERS sheet — give each machine its own series prefix in Settings.';
      $('error').hidden = false;
    }
  } catch (err) {
    $('error').textContent = 'Export failed: ' + err.message;
    $('error').hidden = false;
  }
});
