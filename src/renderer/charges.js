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
  const list = $('charge-list');
  list.innerHTML = '';

  for (const c of active) {
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
    meta.textContent = c.gst_rate + '% · from ' + c.effective_from;

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
    await unwrap(window.api.charges.revise(charge.id, {
      description: desc.value.trim(),
      base_amount: value,
      effective_from: from.value || new Date().toISOString().slice(0, 10)
    }));
    await render();
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.appendChild(save);

  panel.append(note, mk('Description', desc), mk('Amount before tax', amount),
    mk('Effective from', from), error, actions);
}

$('show-new').addEventListener('click', function () {
  $('new-form').hidden = !$('new-form').hidden;
  if (!$('new-form').hidden) $('n-from').value = new Date().toISOString().slice(0, 10);
});
$('cancel-new').addEventListener('click', function () { $('new-form').hidden = true; });

$('save-new').addEventListener('click', async function () {
  const desc = $('n-desc').value.trim();
  const amount = parseFloat($('n-amount').value);

  if (!desc || !(amount >= 0)) {
    $('new-error').textContent = 'Description and amount are both needed.';
    $('new-error').hidden = false;
    return;
  }
  $('new-error').hidden = true;

  await unwrap(window.api.charges.add({
    description: desc,
    base_amount: amount,
    gst_rate: parseFloat($('n-rate').value) || 18,
    effective_from: $('n-from').value || new Date().toISOString().slice(0, 10),
    needs_confirmation: 0
  }));

  ['n-desc', 'n-amount'].forEach(function (id) { $(id).value = ''; });
  $('new-form').hidden = true;
  await render();
});

render();
