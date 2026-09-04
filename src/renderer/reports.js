'use strict';

const $ = function (id) { return document.getElementById(id); };

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function financialYearRange(now) {
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const iso = function (d) { return d.toISOString().slice(0, 10); };
  return {
    from: iso(new Date(startYear, 3, 1)),
    to: iso(new Date(startYear + 1, 2, 31)),
    label: 'FY' + String(startYear % 100).padStart(2, '0') + String((startYear + 1) % 100).padStart(2, '0')
  };
}

function monthRange(now) {
  const iso = function (d) { return d.toISOString().slice(0, 10); };
  return {
    from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    label: now.toISOString().slice(0, 7)
  };
}

function currentRange() {
  const now = new Date();
  const preset = $('preset').value;
  if (preset === 'fy') return financialYearRange(now);
  if (preset === 'month') return monthRange(now);
  return { from: $('from').value, to: $('to').value, label: 'custom' };
}

function describe() {
  const r = currentRange();
  $('range-note').textContent = r.from && r.to ? r.from + ' to ' + r.to : '';
}

$('preset').addEventListener('change', function () {
  $('custom-range').hidden = $('preset').value !== 'custom';
  describe();
});
$('from').addEventListener('change', describe);
$('to').addEventListener('change', describe);
describe();

$('export').addEventListener('click', async function () {
  const range = currentRange();
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
    const result = await unwrap(window.api.reports.export(range.from, range.to, target));
    $('range-note').textContent = result.invoices + ' invoices exported to ' + result.path;
    $('range-note').className = 'hint ok';
  } catch (err) {
    $('error').textContent = 'Export failed: ' + err.message;
    $('error').hidden = false;
  }
});
