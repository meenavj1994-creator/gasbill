'use strict';

const $ = function (id) { return document.getElementById(id); };
const money = function (n) { return Number(n).toFixed(2); };

let distributor = null;
let charges = [];
let lines = [];
let totals = null;
let saving = false;

async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.data;
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

async function boot() {
  distributor = await unwrap(window.api.distributor.get());
  if (!distributor || !distributor.setup_complete) {
    window.location.href = 'setup.html';
    return;
  }

  $('bar-distributor').textContent = distributor.trade_name;
  $('bar-gstin').textContent = distributor.gstin;
  await refreshNumber();

  charges = await unwrap(window.api.charges.active());
  populateChargeSelect();
  await populateSetSelect();

  const unconfirmed = charges.filter(function (c) { return c.needs_confirmation; }).length;
  if (unconfirmed > 0) {
    showNotice(unconfirmed + ' charges still need their rate confirmed. Open Charges before billing.');
  } else {
    await checkBackupAge();
  }

  wire();
  render();
  $('consumer-no').focus();

  const pendingVersion = await unwrap(window.api.updates.pending());
  if (pendingVersion) showUpdateBanner(pendingVersion);
  window.api.updates.onReady(showUpdateBanner);
}

function showUpdateBanner(version) {
  $('update-text').textContent = 'Version ' + version + ' has been downloaded.';
  $('update-banner').hidden = false;
}

async function refreshNumber() {
  $('next-number').textContent = await unwrap(window.api.invoice.preview(new Date().toISOString()));
}

function showNotice(text) {
  const el = $('backup-warning');
  el.textContent = text;
  el.hidden = false;
}

async function checkBackupAge() {
  const last = await unwrap(window.api.backup.last());
  if (!last) return;
  const days = (Date.now() - new Date(last.created_at).getTime()) / 86400000;
  if (days > 7) showNotice('Last backup was ' + Math.floor(days) + ' days ago.');
}

function makeCombo(input, listEl, getItems, onPick, renderItem) {
  let shown = [];
  let sel = 0;

  function close() {
    listEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  async function draw() {
    const query = input.value.trim();
    shown = query ? await getItems(query) : [];
    listEl.innerHTML = '';

    if (!shown.length) { close(); return; }

    shown.forEach(function (item, i) {
      const row = document.createElement('div');
      row.className = 'combo-item' + (i === sel ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      renderItem(row, item);
      row.addEventListener('mousedown', function (e) {
        e.preventDefault();
        sel = i;
        pick();
      });
      listEl.appendChild(row);
    });

    listEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function pick() {
    if (!shown[sel]) return;
    onPick(shown[sel]);
    sel = 0;
    close();
  }

  let timer = null;
  input.addEventListener('input', function () {
    sel = 0;
    clearTimeout(timer);
    timer = setTimeout(draw, 120);
  });

  input.addEventListener('keydown', function (e) {
    if (listEl.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = Math.min(sel + 1, shown.length - 1);
      draw();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', function () { setTimeout(close, 120); });
  return { close: close };
}

function populateChargeSelect() {
  const select = $('charge-select');
  select.innerHTML = '';

  /* Services and products are the same kind of line on an invoice, but a
     distributor thinks of them separately, so they get their own groups. */
  const groups = [
    ['Service charges', 'service'],
    ['Products', 'product']
  ];

  for (const group of groups) {
    const matching = charges
      .map(function (charge, index) { return { charge: charge, index: index }; })
      .filter(function (entry) {
        return group[1] === 'product'
          ? entry.charge.kind === 'product'
          : entry.charge.kind !== 'product';
      });
    if (!matching.length) continue;

    const holder = document.createElement('optgroup');
    holder.label = group[0];
    for (const entry of matching) {
      const option = document.createElement('option');
      option.value = String(entry.index);
      option.textContent = entry.charge.description + ' — ' + money(entry.charge.base_amount) +
        (entry.charge.needs_confirmation ? ' · unconfirmed' : '');
      holder.appendChild(option);
    }
    select.appendChild(holder);
  }
}

async function populateSetSelect() {
  const sets = await unwrap(window.api.bundles.list());
  const select = $('set-select');
  select.innerHTML = '';

  for (const set of sets) {
    const option = document.createElement('option');
    option.value = String(set.id);
    option.textContent = set.name + ' — ' + set.items.length +
      (set.items.length === 1 ? ' item' : ' items');
    select.appendChild(option);
  }

  $('set-row').hidden = sets.length === 0;
}

async function addSelectedSet() {
  const id = Number($('set-select').value);
  if (!id) return;

  const resolved = await unwrap(window.api.bundles.resolve(id));
  for (const entry of resolved.resolved) {
    for (let n = 0; n < (entry.qty || 1); n++) addLine(entry.charge);
  }

  if (resolved.missing.length) {
    toast('Added, but ' + resolved.missing.join(' and ') + ' is no longer in the charge list', 'bad');
  }
}

function addSelectedCharge() {
  const select = $('charge-select');
  if (select.selectedIndex < 0 || !charges.length) return;
  addLine(charges[Number(select.value)]);
}

function wire() {
  makeCombo($('consumer-no'), $('consumer-results'),
    function (query) { return unwrap(window.api.consumers.search(query, 6)); },
    function (person) { applyConsumer(person); },
    function (row, person) {
      const name = document.createElement('span');
      name.className = 'combo-main';
      name.textContent = person.name;
      const no = document.createElement('span');
      no.className = 'combo-side';
      no.textContent = person.consumer_no;
      row.append(name, no);
    });

  $('add-charge').addEventListener('click', addSelectedCharge);
  $('add-set').addEventListener('click', addSelectedSet);
  $('charge-select').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addSelectedCharge(); }
  });

  $('consumer-no').addEventListener('blur', lookupConsumer);
  $('consumer-no').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      e.preventDefault();
      lookupConsumer();
    }
  });

  $('card-edit').addEventListener('click', function () {
    $('customer-fields').hidden = false;
    $('customer-name').focus();
  });

  $('customer-name').addEventListener('input', function () {
    $('customer-name-error').hidden = true;
    syncDirty();
  });
  $('customer-gstin').addEventListener('blur', validateCustomerGstin);
  $('customer-gstin').addEventListener('input', function () {
    $('gstin-result').textContent = '';
    $('gstin-result').className = 'hint';
  });

  $('t-discount').addEventListener('input', function () { recalc(); });
  $('save').addEventListener('click', function () { submit(false); });
  $('save-print').addEventListener('click', function () { submit(true); });

  $('update-install').addEventListener('click', function () { window.api.updates.install(); });

  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey) return;
    if (e.key === 'p') { e.preventDefault(); submit(true); }
    else if (e.key === 'n') { e.preventDefault(); reset(null); }
    else if (e.key === 's') { e.preventDefault(); submit(false); }
    else if (e.key === 'k') { e.preventDefault(); $('charge-select').focus(); }
  });
}

async function lookupConsumer() {
  const no = $('consumer-no').value.trim();
  if (!no || $('customer-name').value) return;
  const found = await unwrap(window.api.consumers.find(no));
  if (found) applyConsumer(found);
  else showManualEntry(no);
}

function applyConsumer(person) {
  $('consumer-no').value = person.consumer_no;
  $('customer-name').value = person.name || '';
  $('customer-address').value = person.address || '';
  $('card-name').textContent = person.name || '';
  $('card-meta').textContent = person.address || 'No address on file';
  $('customer-card').hidden = false;
  $('customer-fields').hidden = true;
  $('lookup-result').textContent = '';
  $('charge-select').focus();
  syncDirty();
}

function showManualEntry(no) {
  $('customer-card').hidden = true;
  $('customer-fields').hidden = false;
  $('lookup-result').textContent = no
    ? 'Not in the consumer base. Enter the details below.'
    : '';
  $('lookup-result').className = 'hint';
}

async function validateCustomerGstin() {
  const raw = $('customer-gstin').value.trim();
  const out = $('gstin-result');
  if (!raw) { out.textContent = ''; out.className = 'hint'; return true; }

  const result = await unwrap(window.api.validateGstin(raw, null));
  if (result.valid) {
    $('customer-gstin').value = result.gstin;
    out.textContent = 'Valid GSTIN. This invoice reports as B2B.';
    out.className = 'hint ok';
    return true;
  }
  out.textContent = result.reason;
  out.className = 'hint bad';
  return false;
}

function addLine(charge) {
  const existing = lines.find(function (l) { return l.description === charge.description; });
  if (existing) existing.qty++;
  else lines.push({
    description: charge.description,
    qty: 1,
    rate: charge.base_amount,
    gstRate: charge.gst_rate,
    needsConfirmation: !!charge.needs_confirmation
  });

  $('lines-error').hidden = true;
  render();
}

function render() {
  const list = $('line-list');
  list.innerHTML = '';
  $('lines-empty').hidden = lines.length > 0;

  lines.forEach(function (line, index) {
    const li = document.createElement('li');
    li.className = 'line-item';

    const desc = document.createElement('div');
    desc.className = 'line-desc';
    desc.textContent = line.description;
    if (line.needsConfirmation) {
      const warn = document.createElement('span');
      warn.className = 'line-warn';
      warn.textContent = 'Rate not yet confirmed';
      desc.appendChild(warn);
    }

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'step';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Reduce ' + line.description);
    minus.addEventListener('click', function () {
      lines[index].qty--;
      if (lines[index].qty < 1) lines.splice(index, 1);
      render();
    });

    const qty = document.createElement('span');
    qty.className = 'line-qty';
    qty.textContent = String(line.qty);

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'step';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Add another ' + line.description);
    plus.addEventListener('click', function () {
      lines[index].qty++;
      render();
    });

    const amount = document.createElement('span');
    amount.className = 'line-amount';
    amount.textContent = money(line.qty * line.rate);

    li.append(desc, minus, qty, plus, amount);
    list.appendChild(li);
  });

  recalc();
  syncDirty();
}

function syncDirty() {
  window.api.markDirty(!!($('customer-name').value.trim() || lines.length));
}

let animFrame = null;
let displayed = 0;

/* One row per GST rate rather than a fixed "CGST @ 9%" pair — an invoice can
   now mix an 18% service with a 28% hot plate, and a single line cannot say
   that truthfully. */
function renderTaxRows(byRate, intraState) {
  const box = $('t-tax-rows');
  box.innerHTML = '';

  for (const bucket of byRate || []) {
    const parts = intraState
      ? [['CGST @ ' + (bucket.rate / 2) + '%', bucket.cgst], ['SGST @ ' + (bucket.rate / 2) + '%', bucket.sgst]]
      : [['IGST @ ' + bucket.rate + '%', bucket.igst]];

    for (const part of parts) {
      const row = document.createElement('div');
      row.className = 'total-row';
      const label = document.createElement('span');
      label.textContent = part[0];
      const value = document.createElement('span');
      value.textContent = money(part[1]);
      row.append(label, value);
      box.appendChild(row);
    }
  }
}

function discountValue() {
  const n = Number($('t-discount').value);
  return n > 0 ? n : 0;
}

async function recalc() {
  if (lines.length === 0) {
    totals = null;
    $('t-gross').textContent = '0.00';
    $('t-taxable').textContent = '0.00';
    $('t-rounding').textContent = '0.00';
    renderTaxRows([], true);
    animateTotal(0);
    $('t-words').textContent = '';
    return;
  }

  totals = await unwrap(window.api.compute(lines, distributor.state_code, distributor.state_code, discountValue()));
  $('t-gross').textContent = money(totals.gross);
  $('t-taxable').textContent = money(totals.taxable);
  renderTaxRows(totals.byRate, totals.intraState);
  $('t-rounding').textContent = (totals.rounding >= 0 ? '+' : '') + money(totals.rounding);
  animateTotal(totals.total);
}

function showTotal(value) {
  $('t-total').textContent = '₹' + Math.round(value).toLocaleString('en-IN');
}

function animateTotal(target) {
  if (animFrame) cancelAnimationFrame(animFrame);
  const from = displayed;
  const start = performance.now();

  /* The real figure goes up first, synchronously. requestAnimationFrame does
     not tick while Chromium considers the window occluded, and counting up to
     the total is decoration — showing ₹0 on a finished invoice because a frame
     never arrived is not. The animation overwrites this on its first frame and
     lands on the same number. */
  displayed = target;
  showTotal(target);

  function step(now) {
    const p = Math.min((now - start) / 300, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    displayed = from + (target - from) * eased;
    showTotal(displayed);
    if (p < 1) animFrame = requestAnimationFrame(step);
    else displayed = target;
  }

  // Scheduled, never called inline — calling it here would immediately paint
  // the old value back over the one just written.
  animFrame = requestAnimationFrame(step);
}

async function submit(thenPrint) {
  if (saving) return;

  const name = $('customer-name').value.trim();
  let valid = true;

  if (!name) {
    $('customer-fields').hidden = false;
    $('customer-name-error').textContent = 'Enter a customer name.';
    $('customer-name-error').hidden = false;
    valid = false;
  }
  if (lines.length === 0) {
    $('lines-error').textContent = 'Add at least one charge.';
    $('lines-error').hidden = false;
    valid = false;
  }
  if (!(await validateCustomerGstin())) valid = false;
  if (!valid) return;

  saving = true;
  $('save').disabled = true;
  $('save-print').disabled = true;
  $('save-print').classList.add('busy');

  let saved;
  try {
    saved = await unwrap(window.api.invoice.save({
      consumer_no: $('consumer-no').value.trim() || null,
      customer_name: name,
      customer_address: $('customer-address').value.trim() || null,
      customer_gstin: $('customer-gstin').value.trim() || null,
      place_of_supply: 'Madhya Pradesh',
      place_of_supply_code: distributor.state_code,
      invoice_date: new Date().toISOString(),
      discount: discountValue(),
      lines: lines
    }));
  } catch (err) {
    toast('Could not save: ' + err.message, 'bad');
    return;
  } finally {
    saving = false;
    $('save').disabled = false;
    $('save-print').disabled = false;
    $('save-print').classList.remove('busy');
  }

  if (thenPrint) {
    await renderPrintable(saved);
    await window.api.print();
  }
  toast('Saved as ' + saved.invoice_no, 'ok');
  reset();
}

async function renderPrintable(invoice) {
  const area = $('print-area');
  area.innerHTML = '';

  ['Original for recipient', 'Duplicate for supplier'].forEach(function (copyLabel) {
    const node = $('invoice-template').content.cloneNode(true);
    const set = function (sel, text) {
      const el = node.querySelector(sel);
      if (el) el.textContent = text || '';
    };

    const logo = node.querySelector('[data-logo]');
    if (logo && distributor.logo_path) {
      logo.addEventListener('error', function () { logo.hidden = true; });
      logo.src = 'file:///' + distributor.logo_path.replace(/\\/g, '/');
      logo.hidden = false;
    }

    set('[data-copy]', copyLabel);
    set('[data-trade-name]', distributor.trade_name);
    set('[data-supplier-address]', distributor.address);
    set('[data-supplier-gstin]', distributor.gstin);
    set('[data-invoice-no]', invoice.invoice_no);
    set('[data-invoice-date]', invoice.invoice_date.split('-').reverse().join('.'));
    set('[data-customer-name]', invoice.customer_name);
    set('[data-customer-address]', invoice.customer_address);
    set('[data-consumer-line]', invoice.consumer_no ? 'Consumer no ' + invoice.consumer_no : '');
    set('[data-customer-gstin-line]', invoice.customer_gstin ? 'GSTIN ' + invoice.customer_gstin : '');
    set('[data-place-of-supply]', 'Place of supply — ' + invoice.place_of_supply + ' (' + invoice.place_of_supply_code + ')');
    set('[data-words]', invoice.amount_in_words);
    set('[data-sign-for]', 'For ' + distributor.trade_name);

    if (copyLabel.indexOf('Duplicate') === 0) {
      const ack = node.querySelector('[data-ack]');
      const sign = node.querySelector('[data-customer-sign]');
      const thanks = node.querySelector('[data-thanks]');
      if (ack && distributor.ack_text) {
        ack.textContent = distributor.ack_text;
        ack.hidden = false;
      }
      if (sign) sign.hidden = false;
      if (thanks) thanks.hidden = true;
    }

    /* Tax lives in the line columns — CGST and SGST (or IGST) per line with a
       totals footer — rather than as rows under the table. Rule 46 wants
       taxable value, rate and tax amount; the columns give all three per
       line, and the bottom block stays four rows however many rates mix. */
    const intra = !(invoice.igst > 0);
    const taxCols = intra ? [['cgst', 'CGST'], ['sgst', 'SGST']] : [['igst', 'IGST']];
    const table = node.querySelector('.doc-lines');
    table.classList.add(intra ? 'doc-lines-intra' : 'doc-lines-inter');

    const cell = function (tag, cls, text) {
      const el = document.createElement(tag);
      el.className = cls;
      el.textContent = text;
      return el;
    };
    const taxCell = function (rate, amount) {
      const td = cell('td', 'c-tax', '');
      const pct = document.createElement('span');
      pct.className = 'doc-pct';
      pct.textContent = rate + '%';
      td.append(pct, document.createTextNode(money(amount)));
      return td;
    };

    const headRow = document.createElement('tr');
    headRow.append(cell('th', 'c-desc', 'Description'), cell('th', 'c-qty', 'Qty'),
      cell('th', 'c-rate', 'Rate'), cell('th', 'c-taxable', 'Taxable'));
    taxCols.forEach(function (col) { headRow.appendChild(cell('th', 'c-tax', col[1])); });
    headRow.appendChild(cell('th', 'c-amt', 'Total'));
    node.querySelector('[data-head]').appendChild(headRow);

    const sums = { taxable: 0, cgst: 0, sgst: 0, igst: 0, amt: 0 };
    const body = node.querySelector('[data-lines]');
    for (const line of invoice.lines) {
      const taxable = Number(line.line_total) || 0;
      const tax = Number(line.tax_amount) || 0;
      const rate = Number(line.gst_rate) || 0;
      const half = Math.round(tax * 50) / 100;
      const parts = intra
        ? { cgst: half, sgst: Math.round((tax - half) * 100) / 100, igst: 0 }
        : { cgst: 0, sgst: 0, igst: tax };

      const tr = document.createElement('tr');
      tr.append(cell('td', 'c-desc', line.description), cell('td', 'c-qty', String(line.qty)),
        cell('td', 'c-rate', money(line.rate)), cell('td', 'c-taxable', money(taxable)));
      taxCols.forEach(function (col) { tr.appendChild(taxCell(rate / taxCols.length, parts[col[0]])); });
      tr.appendChild(cell('td', 'c-amt', money(taxable + tax)));
      body.appendChild(tr);

      sums.taxable += taxable;
      sums.cgst += parts.cgst;
      sums.sgst += parts.sgst;
      sums.igst += parts.igst;
      sums.amt += taxable + tax;
    }

    const footRow = document.createElement('tr');
    footRow.append(cell('td', 'c-desc', 'Total'), cell('td', 'c-qty', ''), cell('td', 'c-rate', ''),
      cell('td', 'c-taxable', money(sums.taxable)));
    taxCols.forEach(function (col) { footRow.appendChild(cell('td', 'c-tax', money(sums[col[0]]))); });
    footRow.appendChild(cell('td', 'c-amt', money(sums.amt)));
    node.querySelector('[data-foot]').appendChild(footRow);

    const totalsBox = node.querySelector('[data-totals]');
    const rows = [];
    const discount = Number(invoice.discount) || 0;
    if (discount > 0) {
      rows.push(['Gross value', money(invoice.taxable_value + discount)]);
      rows.push(['Less discount', money(discount)]);
    }
    rows.push(['Taxable value', money(invoice.taxable_value)]);
    rows.push(['Total with GST', money(invoice.taxable_value + invoice.cgst + invoice.sgst + invoice.igst)]);
    rows.push(['Round off', money(invoice.rounding)]);

    rows.forEach(function (pair) {
      const div = document.createElement('div');
      div.className = 'doc-total-row';
      div.innerHTML = '<span></span><span></span>';
      div.children[0].textContent = pair[0];
      div.children[1].textContent = pair[1];
      totalsBox.appendChild(div);
    });

    const final = document.createElement('div');
    final.className = 'doc-total-row doc-total-final';
    final.innerHTML = '<span></span><span></span>';
    final.children[0].textContent = 'Total';
    final.children[1].textContent = '₹' + invoice.total;
    totalsBox.appendChild(final);

    area.appendChild(node);
  });
}

async function reset() {
  lines = [];
  ['consumer-no', 'customer-name', 'customer-address', 'customer-gstin', 't-discount']
    .forEach(function (id) { $(id).value = ''; });
  $('customer-card').hidden = true;
  $('customer-fields').hidden = true;
  $('lookup-result').textContent = '';
  $('gstin-result').textContent = '';
  $('lines-error').hidden = true;
  await refreshNumber();
  render();
  $('consumer-no').focus();
}

boot().catch(function (err) {
  document.body.innerHTML = '<p style="padding:24px;color:#A32D2D">Could not start: ' + err.message + '</p>';
});
