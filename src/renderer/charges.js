'use strict';

const $ = function (id) { return document.getElementById(id); };
const money = function (n) { return Number(n).toFixed(2); };

async function unwrap(p) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

async function render() {
  const active = await unwrap(window.api.charges.active());
  active.sort(function (a, b) {
    if (a.needs_confirmation !== b.needs_confirmation) return b.needs_confirmation - a.needs_confirmation;
    return a.description.localeCompare(b.description);
  });

  renderGroup($('charge-list'), active.filter(function (c) { return c.kind !== 'product' && c.kind !== 'deposit'; }));
  const products = active.filter(function (c) { return c.kind === 'product'; });
  renderGroup($('product-list'), products);
  $('products-empty').hidden = products.length > 0;
  const deposits = active.filter(function (c) { return c.kind === 'deposit'; });
  renderGroup($('deposit-list'), deposits);
  $('deposits-empty').hidden = deposits.length > 0;

  await renderSets(active);
}

function renderGroup(list, items) {
  list.innerHTML = '';

  for (const c of items) {
    const li = document.createElement('li');
    li.className = 'charge-item' + (c.needs_confirmation ? ' pending' : '');

    const head = document.createElement('div');
    head.className = 'charge-head';
    const desc = document.createElement('span');
    desc.textContent = c.description;
    const amount = document.createElement('span');
    amount.className = 'charge-amount';
    amount.textContent = money(c.base_amount);
    head.append(desc, amount);

    const meta = document.createElement('div');
    meta.className = 'charge-meta';
    const bits = [];
    if (c.kind === 'deposit') bits.push('No GST');
    else bits.push(c.gst_rate + '%' + (c.price_includes_gst ? ' included in amount' : ''));
    if (c.hsn_sac) bits.push((c.kind === 'product' ? 'HSN ' : 'SAC ') + c.hsn_sac);
    bits.push('from ' + c.effective_from);
    meta.textContent = bits.join(' · ');

    const row = document.createElement('div');
    row.className = 'charge-actions';

    const badge = document.createElement('span');
    if (c.needs_confirmation) {
      badge.className = 'badge badge-warn';
      badge.textContent = 'Needs confirming';
    } else {
      badge.className = 'badge badge-on';
      badge.textContent = 'Active';
    }
    row.appendChild(badge);
    if (!c.hsn_sac && c.kind !== 'deposit') {
      const noCode = document.createElement('span');
      noCode.className = 'badge badge-warn';
      noCode.textContent = 'No HSN/SAC';
      row.appendChild(noCode);
    }

    const revise = document.createElement('button');
    revise.type = 'button';
    revise.className = 'line-remove';
    revise.textContent = c.needs_confirmation ? 'Confirm details' : 'Revise rate';
    revise.addEventListener('click', function () { openRevise(c); });
    row.appendChild(revise);

    li.append(head, meta, row);

    const panel = document.createElement('div');
    panel.className = 'revise-panel';
    panel.hidden = true;
    panel.dataset.for = String(c.id);
    li.appendChild(panel);

    list.appendChild(li);
  }
}

function openRevise(charge) {
  const panel = document.querySelector('.revise-panel[data-for="' + charge.id + '"]');
  if (!panel.hidden) { panel.hidden = true; return; }

  const confirming = charge.needs_confirmation;
  panel.innerHTML = '';
  panel.hidden = false;

  const mk = function (labelText, input) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.append(label, input);
    return wrap;
  };

  const desc = document.createElement('input');
  desc.value = charge.description;

  const amount = document.createElement('input');
  amount.type = 'number';
  amount.step = '0.01';
  amount.min = '0';
  amount.value = String(charge.base_amount);

  const taxRate = document.createElement('input');
  taxRate.type = 'number';
  taxRate.step = '0.5';
  taxRate.min = '0';
  taxRate.max = '100';
  taxRate.value = String(charge.gst_rate);

  const code = document.createElement('input');
  code.value = charge.hsn_sac || '';
  code.maxLength = 8;
  code.setAttribute('list', 'code-hints');
  const suggested = suggestCode(charge.description, charge.kind);
  if (!charge.hsn_sac && suggested) code.placeholder = 'Suggested: ' + suggested;

  const incl = document.createElement('input');
  incl.type = 'checkbox';
  incl.checked = !!charge.price_includes_gst;
  const inclRow = document.createElement('label');
  inclRow.className = 'check-row';
  const inclText = document.createElement('span');
  inclText.textContent = 'Amount includes GST';
  inclRow.append(incl, inclText);

  const kind = document.createElement('select');
  [['service', 'Service charge'], ['product', 'Product'], ['deposit', 'Deposit — no GST']].forEach(function (pair) {
    const option = document.createElement('option');
    option.value = pair[0];
    option.textContent = pair[1];
    kind.appendChild(option);
  });
  kind.value = charge.kind || 'service';

  const from = document.createElement('input');
  from.type = 'date';
  from.value = new Date().toISOString().slice(0, 10);

  const error = document.createElement('p');
  error.className = 'error';
  error.hidden = true;

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = confirming
    ? 'Check these against your current territory circular before saving.'
    : 'The current rate stays on file. Past invoices keep the rate they were raised at.';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = confirming ? 'Confirm' : 'Save revision';
  save.addEventListener('click', async function () {
    const value = parseFloat(amount.value);
    if (!desc.value.trim()) {
      error.textContent = 'Enter a description.';
      error.hidden = false;
      return;
    }
    if (!(value >= 0)) {
      error.textContent = 'Enter an amount.';
      error.hidden = false;
      return;
    }
    const rate = parseFloat(taxRate.value);
    if (!(rate >= 0 && rate <= 100)) {
      error.textContent = 'Enter a GST rate between 0 and 100.';
      error.hidden = false;
      return;
    }
    await unwrap(window.api.charges.revise(charge.id, {
      description: desc.value.trim(),
      base_amount: value,
      gst_rate: rate,
      kind: kind.value,
      hsn_sac: code.value.trim() || null,
      price_includes_gst: incl.checked ? 1 : 0,
      effective_from: from.value || new Date().toISOString().slice(0, 10)
    }));
    await render();
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.appendChild(save);

  const grid = document.createElement('div');
  grid.className = 'field-grid';
  grid.append(mk('Amount', amount), mk('GST rate (%)', taxRate),
    mk('Type', kind), mk('Effective from', from), mk('HSN / SAC code', code), inclRow);

  panel.append(note, mk('Description', desc), grid, error, actions);
}

$('show-new').addEventListener('click', function () {
  $('new-form').hidden = !$('new-form').hidden;
  if (!$('new-form').hidden) $('n-from').value = new Date().toISOString().slice(0, 10);
});
$('cancel-new').addEventListener('click', function () { $('new-form').hidden = true; });

$('save-new').addEventListener('click', async function () {
  const desc = $('n-desc').value.trim();
  const amount = parseFloat($('n-amount').value);
  const rate = parseFloat($('n-rate').value);

  if (!desc || !(amount >= 0)) {
    $('new-error').textContent = 'Description and amount are both needed.';
    $('new-error').hidden = false;
    return;
  }
  if (!(rate >= 0 && rate <= 100)) {
    $('new-error').textContent = 'Enter a GST rate between 0 and 100.';
    $('new-error').hidden = false;
    return;
  }
  $('new-error').hidden = true;

  await unwrap(window.api.charges.add({
    description: desc,
    base_amount: amount,
    gst_rate: rate,
    kind: $('n-kind').value,
    hsn_sac: $('n-code').value.trim() || null,
    price_includes_gst: $('n-incl').checked ? 1 : 0,
    effective_from: $('n-from').value || new Date().toISOString().slice(0, 10),
    needs_confirmation: 0
  }));

  ['n-desc', 'n-amount', 'n-code'].forEach(function (id) { $(id).value = ''; });
  $('n-incl').checked = false;
  $('new-form').hidden = true;
  await render();
});

/* ---------- Sets ---------- */

let editingSet = null;

async function renderSets(active) {
  const sets = await unwrap(window.api.bundles.list());
  const list = $('set-list');
  list.innerHTML = '';
  $('sets-empty').hidden = sets.length > 0;

  for (const set of sets) {
    const li = document.createElement('li');
    li.className = 'charge-item';

    const head = document.createElement('div');
    head.className = 'charge-head';
    const name = document.createElement('span');
    name.textContent = set.name;
    const count = document.createElement('span');
    count.className = 'charge-amount';
    count.textContent = set.items.length + (set.items.length === 1 ? ' item' : ' items');
    head.append(name, count);

    const meta = document.createElement('div');
    meta.className = 'charge-meta';
    meta.textContent = set.items.map(function (i) {
      return i.qty > 1 ? i.description + ' ×' + i.qty : i.description;
    }).join(' · ') || 'Empty';

    const row = document.createElement('div');
    row.className = 'charge-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'line-remove';
    edit.textContent = 'Edit';
    edit.addEventListener('click', function () { openSet(set, active); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'line-remove';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async function () {
      await unwrap(window.api.bundles.remove(set.id));
      await render();
    });

    row.append(edit, remove);
    li.append(head, meta, row);
    list.appendChild(li);
  }

  if (editingSet !== null) drawSetItems(active);
}

/* One row per item, ticked if the set already carries it. Items are matched by
   description because that is what the set stores — a charge gets a new id
   every time its rate is revised. */
function drawSetItems(active) {
  const box = $('s-items');
  box.innerHTML = '';
  const chosen = new Map((editingSet.items || []).map(function (i) { return [i.description, i.qty]; }));

  for (const c of active) {
    const row = document.createElement('label');
    row.className = 'pick-row';

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = chosen.has(c.description);
    tick.dataset.description = c.description;

    const name = document.createElement('span');
    name.className = 'pick-name';
    name.textContent = c.description;

    const tag = document.createElement('span');
    tag.className = 'badge ' + (c.kind === 'product' ? 'badge-on' : 'badge-off');
    tag.textContent = c.kind === 'product' ? 'Product' : 'Service';

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.step = '1';
    qty.className = 'pick-qty';
    qty.value = String(chosen.get(c.description) || 1);

    row.append(tick, name, tag, qty);
    box.appendChild(row);
  }
}

function openSet(set, active) {
  editingSet = set || { name: '', items: [] };
  $('s-name').value = editingSet.name || '';
  $('set-error').hidden = true;
  $('set-form').hidden = false;
  drawSetItems(active);
}

$('show-set').addEventListener('click', async function () {
  if (!$('set-form').hidden) { $('set-form').hidden = true; editingSet = null; return; }
  openSet(null, await unwrap(window.api.charges.active()));
});

$('cancel-set').addEventListener('click', function () {
  $('set-form').hidden = true;
  editingSet = null;
});

$('save-set').addEventListener('click', async function () {
  const name = $('s-name').value.trim();
  if (!name) {
    $('set-error').textContent = 'Give the set a name.';
    $('set-error').hidden = false;
    return;
  }

  const items = [];
  for (const row of $('s-items').querySelectorAll('.pick-row')) {
    const tick = row.querySelector('input[type="checkbox"]');
    if (!tick.checked) continue;
    items.push({
      description: tick.dataset.description,
      qty: parseFloat(row.querySelector('.pick-qty').value) || 1
    });
  }

  if (!items.length) {
    $('set-error').textContent = 'Tick at least one item.';
    $('set-error').hidden = false;
    return;
  }

  await unwrap(window.api.bundles.save({ id: editingSet.id, name: name, items: items }));
  $('set-form').hidden = true;
  editingSet = null;
  await render();
});

render();

/* A deposit carries no GST, so the rate and inclusive fields have nothing
   to say for it. */
$('n-kind').addEventListener('change', function () {
  const deposit = $('n-kind').value === 'deposit';
  $('n-rate').disabled = deposit;
  $('n-incl').disabled = deposit;
  if (deposit) { $('n-rate').value = '0'; $('n-incl').checked = false; }
  else if ($('n-rate').value === '0') $('n-rate').value = '18';
});

(async function codeHints() {
  const hints = await unwrap(window.api.charges.codeHints());
  const list = $('code-hints');
  const table = $('code-table');
  for (const h of hints) {
    const option = document.createElement('option');
    option.value = h.code;
    option.label = h.label;
    list.appendChild(option);

    const tr = document.createElement('tr');
    const code = document.createElement('td');
    code.className = 'code';
    code.textContent = h.code;
    const label = document.createElement('td');
    label.textContent = h.label;
    tr.append(code, label);
    table.appendChild(tr);
  }
})();

/* A placeholder, never a value: the distributor still has to type or pick
   the code, but the likely one is in front of them. */
function suggestCode(description, kind) {
  const d = String(description || '').toLowerCase();
  if (kind === 'deposit') return null;
  if (/hose|tube|pipe/.test(d)) return '4009';
  if (/hot ?plate|stove|burner|hob|cooking range/.test(d)) return '7321';
  if (/regulator/.test(d)) return '8481';
  if (/lighter/.test(d)) return '9613';
  if (/dgcc|document|admin|visit and admin|termination/.test(d)) return '998599';
  if (/install|demonstrat/.test(d)) return '998739';
  if (/inspection|mechanic|servic|repair/.test(d)) return '998729';
  return null;
}
$('n-desc').addEventListener('input', function () {
  const s = suggestCode($('n-desc').value, $('n-kind').value);
  $('n-code').placeholder = s ? 'Suggested: ' + s : 'e.g. 4009';
});
