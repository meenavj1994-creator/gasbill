'use strict';

const $ = function (id) { return document.getElementById(id); };

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

let distributor = null;

function dmy(iso) { return iso.split('-').reverse().join('.'); }
function rupees(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

async function currentRange() {
  const preset = $('preset').value;
  if (preset === 'all') return { from: null, to: null };
  if (preset === 'custom') return { from: $('from').value || null, to: $('to').value || null };
  const period = await unwrap(window.api.reports.period(preset, new Date().toISOString()));
  return { from: period.from, to: period.to };
}

async function load() {
  const range = await currentRange();
  const q = $('q').value.trim();
  const rows = await unwrap(window.api.invoice.list({ from: range.from, to: range.to, q: q || null }));

  const body = $('rows');
  body.innerHTML = '';
  $('empty').hidden = rows.length > 0;
  $('table').hidden = rows.length === 0;
  $('count').textContent = rows.length ? rows.length + (rows.length === 500 ? '+' : '') : '';

  for (const inv of rows) body.appendChild(rowFor(inv));
}

function rowFor(inv) {
  const tr = document.createElement('tr');
  tr.dataset.id = inv.id;

  const cells = [
    ['num', inv.invoice_no],
    ['num', dmy(inv.invoice_date)],
    ['', inv.customer_name],
    ['num', inv.consumer_no || ''],
    ['num right', rupees(inv.total)]
  ];
  cells.forEach(function (c) {
    const td = document.createElement('td');
    td.className = c[0];
    td.textContent = c[1];
    tr.appendChild(td);
  });

  const acts = document.createElement('td');
  acts.className = 'acts';
  acts.append(
    button('Print', function () { reprint(inv.id); }),
    button('Edit', function () { window.location.href = 'index.html?edit=' + inv.id; }),
    button('Delete', function () { askDelete(tr, inv); }, 'danger')
  );
  tr.appendChild(acts);
  return tr;
}

function button(label, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

async function reprint(id) {
  const inv = await unwrap(window.api.invoice.get(id));
  if (!inv) { toast('That invoice no longer exists.', 'bad'); return load(); }
  Printable.render(inv, distributor);
  await window.api.print(inv.invoice_no);
}

/* The confirmation sits in the table right under the row, so what is about
   to go is still on screen while deciding. */
function askDelete(tr, inv) {
  const open = document.querySelector('.inv-confirm');
  if (open) open.remove();

  const row = document.createElement('tr');
  row.className = 'inv-confirm';
  const td = document.createElement('td');
  td.colSpan = 6;
  const box = document.createElement('div');
  box.className = 'row';

  const text = document.createElement('span');
  text.textContent = 'Delete ' + inv.invoice_no + ' for ' + inv.customer_name + ' (' + rupees(inv.total) + ')? ' +
    'It leaves the records completely and will not appear in any report.';

  const yes = button('Delete invoice', async function () {
    yes.disabled = true;
    try {
      await unwrap(window.api.invoice.remove(inv.id));
      toast('Deleted ' + inv.invoice_no, 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
      yes.disabled = false;
    }
  }, 'danger');
  const no = button('Keep it', function () { row.remove(); });

  box.append(text, yes, no);
  td.appendChild(box);
  row.appendChild(td);
  tr.after(row);
  no.focus();
}

$('preset').addEventListener('change', function () {
  const custom = $('preset').value === 'custom';
  $('from-field').hidden = !custom;
  $('to-field').hidden = !custom;
  load();
});
$('from').addEventListener('change', load);
$('to').addEventListener('change', load);
let searchTimer = null;
$('q').addEventListener('input', function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 180);
});

(async function boot() {
  distributor = await unwrap(window.api.distributor.get());
  if (!distributor || !distributor.setup_complete) {
    window.location.href = 'setup.html';
    return;
  }
  const saved = new URLSearchParams(window.location.search).get('saved');
  if (saved) toast('Saved as ' + saved, 'ok');
  await load();
})().catch(function (err) {
  document.body.innerHTML = '<p style="padding:24px;color:#A32D2D">Could not start: ' + err.message + '</p>';
});
