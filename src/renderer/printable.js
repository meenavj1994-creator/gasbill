'use strict';

/* Builds the two printed copies of an invoice into #print-area. Used by the
   billing screen straight after save, and by the Invoices page for reprints,
   so both produce the identical document. Needs print.css on the page.

   The layout follows what distributors already hand out — name and logo on
   top, the customer and invoice particulars in two quiet columns, one table
   with the tax inside it, one total — rather than a form with bands and
   labels on everything. Rule 46 particulars are all here; nothing else is. */

const Printable = (function () {

const TEMPLATE = `
  <article class="doc">
    <header class="doc-top">
      <img class="doc-logo" data-logo hidden />
      <div class="doc-id">
        <div class="doc-name" data-trade-name></div>
        <div class="doc-tagline" data-tagline hidden></div>
        <div class="doc-addr"><span data-supplier-address></span></div>
        <div class="doc-addr">GSTIN <span class="doc-mono" data-supplier-gstin></span></div>
      </div>
      <div class="doc-title-block">
        <div class="doc-title">Tax Invoice</div>
        <div class="doc-copy" data-copy></div>
      </div>
    </header>

    <section class="doc-parties">
      <div class="doc-party">
        <div class="doc-kv"><span class="k">Name</span><span data-customer-name></span></div>
        <div class="doc-kv" data-address-row><span class="k">Address</span><span data-customer-address></span></div>
        <div class="doc-kv" data-consumer-row><span class="k">Cons no</span><span class="doc-mono" data-consumer-no></span></div>
        <div class="doc-kv" data-gstin-row><span class="k">GSTIN</span><span class="doc-mono" data-customer-gstin></span></div>
      </div>
      <div class="doc-party doc-party-right">
        <div class="doc-kv"><span class="k">Invoice no</span><span class="doc-mono" data-invoice-no></span></div>
        <div class="doc-kv"><span class="k">Date</span><span class="doc-mono" data-invoice-date></span></div>
        <div class="doc-kv"><span class="k">Place of supply</span><span data-place-of-supply></span></div>
        <div class="doc-kv"><span class="k">Reverse charge</span><span>No</span></div>
      </div>
    </section>

    <table class="doc-lines">
      <thead data-head></thead>
      <tbody data-lines></tbody>
      <tfoot data-foot></tfoot>
    </table>

    <div class="doc-summary">
      <div class="doc-totals" data-totals></div>
      <div class="doc-words" data-words></div>
      <div class="doc-ack" data-ack hidden></div>
    </div>

    <div class="doc-signs">
      <div class="doc-sign-block" data-customer-sign hidden>
        <div class="doc-sign-rule"></div>
        <div class="doc-sign-label">Customer signature</div>
        <div class="doc-sign-fill">Name</div>
        <div class="doc-sign-fill">Date</div>
      </div>
      <div class="doc-sign-block">
        <div class="doc-sign-rule"></div>
        <div class="doc-sign-label" data-sign-for></div>
        <div class="doc-sign-sub">Authorised signatory</div>
      </div>
    </div>
    <div class="doc-foot" data-jurisdiction hidden></div>
  </article>
`;

let cached = null;
function templateNode() {
  if (!cached) {
    cached = document.createElement('template');
    cached.innerHTML = TEMPLATE;
  }
  return cached.content.cloneNode(true);
}

const money = function (n) { return Number(n).toFixed(2); };

function cell(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  el.textContent = text;
  return el;
}

function small(text) {
  const span = document.createElement('span');
  span.className = 'doc-pct';
  span.textContent = text;
  return span;
}

function render(invoice, distributor) {
  const area = document.getElementById('print-area');
  area.innerHTML = '';
  const pending = [];

  const intra = !(invoice.igst > 0);
  const discount = Number(invoice.discount) || 0;
  const hasDiscount = discount > 0;
  const deposits = Number(invoice.non_gst_value) || 0;
  const taxCols = intra ? [['cgst', 'CGST (%)'], ['sgst', 'SGST (%)']] : [['igst', 'IGST (%)']];

  ['Original for recipient', 'Duplicate for supplier'].forEach(function (copyLabel) {
    const node = templateNode();
    const set = function (sel, text) {
      const el = node.querySelector(sel);
      if (el) el.textContent = text || '';
    };
    const show = function (sel, visible) {
      const el = node.querySelector(sel);
      if (el) el.hidden = !visible;
    };

    const logo = node.querySelector('[data-logo]');
    if (logo && distributor.logo_path) {
      // printToPDF runs the moment render returns; an image still loading
      // would print as nothing. Callers await the returned promise.
      pending.push(new Promise(function (resolve) {
        logo.addEventListener('load', resolve);
        logo.addEventListener('error', function () { logo.hidden = true; resolve(); });
        setTimeout(resolve, 1500);
      }));
      logo.src = 'file:///' + distributor.logo_path.replace(/\\/g, '/');
      logo.hidden = false;
    }

    set('[data-copy]', copyLabel);
    set('[data-trade-name]', distributor.trade_name);
    set('[data-tagline]', distributor.tagline);
    show('[data-tagline]', !!distributor.tagline);
    set('[data-supplier-address]', distributor.address);
    set('[data-supplier-gstin]', distributor.gstin);
    set('[data-invoice-no]', invoice.invoice_no);
    set('[data-invoice-date]', invoice.invoice_date.split('-').reverse().join('.'));
    set('[data-customer-name]', invoice.customer_name);
    set('[data-customer-address]', invoice.customer_address);
    show('[data-address-row]', !!invoice.customer_address);
    set('[data-consumer-no]', invoice.consumer_no);
    show('[data-consumer-row]', !!invoice.consumer_no);
    set('[data-customer-gstin]', invoice.customer_gstin);
    show('[data-gstin-row]', !!invoice.customer_gstin);
    set('[data-place-of-supply]', invoice.place_of_supply + ' (' + invoice.place_of_supply_code + ')');
    set('[data-words]', invoice.amount_in_words);
    set('[data-sign-for]', 'For ' + distributor.trade_name);
    set('[data-jurisdiction]', distributor.jurisdiction);
    show('[data-jurisdiction]', !!distributor.jurisdiction);

    if (copyLabel.indexOf('Duplicate') === 0) {
      const ack = node.querySelector('[data-ack]');
      if (ack && distributor.ack_text) {
        ack.textContent = distributor.ack_text;
        ack.hidden = false;
      }
      show('[data-customer-sign]', true);
    }

    /* Tax lives in the line columns — CGST and SGST (or IGST) per line with
       a totals footer. Rule 46 wants taxable value, rate and tax amount; the
       columns give all three per line. Basic is the line amount before tax;
       a Discount column exists only on invoices that carry one, since each
       line's tax is computed on Basic less its share. Deposits show their
       amount under Basic with no tax, and stay out of taxable value. */
    const table = node.querySelector('.doc-lines');
    table.classList.add(intra ? 'doc-lines-intra' : 'doc-lines-inter');
    if (hasDiscount) table.classList.add('doc-lines-disc');

    const headRow = document.createElement('tr');
    headRow.append(cell('th', 'c-desc', 'Description'), cell('th', 'c-code', 'HSN/SAC'),
      cell('th', 'c-qty', 'Qty'), cell('th', 'c-basic', 'Basic'));
    if (hasDiscount) headRow.appendChild(cell('th', 'c-disc', 'Discount'));
    taxCols.forEach(function (col) { headRow.appendChild(cell('th', 'c-tax', col[1])); });
    headRow.appendChild(cell('th', 'c-amt', 'Total'));
    node.querySelector('[data-head]').appendChild(headRow);

    const sums = { basic: 0, disc: 0, cgst: 0, sgst: 0, igst: 0, amt: 0 };
    const body = node.querySelector('[data-lines]');
    for (const line of invoice.lines) {
      const nonGst = !!line.non_gst;
      const taxable = Number(line.line_total) || 0;
      const lineDisc = Number(line.discount) || 0;
      const basic = taxable + lineDisc;
      const tax = Number(line.tax_amount) || 0;
      const rate = Number(line.gst_rate) || 0;
      const qty = Number(line.qty) || 0;
      const half = Math.round(tax * 50) / 100;
      const parts = intra
        ? { cgst: half, sgst: Math.round((tax - half) * 100) / 100, igst: 0 }
        : { cgst: 0, sgst: 0, igst: tax };

      const tr = document.createElement('tr');
      const basicCell = cell('td', 'c-basic', '');
      // Unit rate only earns space when quantity is not one.
      if (qty !== 1) basicCell.appendChild(small('@ ' + money(line.rate)));
      basicCell.appendChild(document.createTextNode(money(basic)));
      tr.append(cell('td', 'c-desc', line.description), cell('td', 'c-code', line.hsn_sac || ''),
        cell('td', 'c-qty', String(line.qty)), basicCell);
      if (hasDiscount) tr.appendChild(cell('td', 'c-disc', nonGst ? '' : money(lineDisc)));
      taxCols.forEach(function (col) {
        if (nonGst) { tr.appendChild(cell('td', 'c-tax', '—')); return; }
        const td = cell('td', 'c-tax', '');
        td.append(small((rate / taxCols.length) + '%'), document.createTextNode(money(parts[col[0]])));
        tr.appendChild(td);
      });
      tr.appendChild(cell('td', 'c-amt', money(taxable + tax)));
      body.appendChild(tr);

      sums.basic += basic;
      sums.disc += lineDisc;
      sums.cgst += parts.cgst;
      sums.sgst += parts.sgst;
      sums.igst += parts.igst;
      sums.amt += taxable + tax;
    }

    const footRow = document.createElement('tr');
    footRow.append(cell('td', 'c-desc', 'Total'), cell('td', 'c-code', ''), cell('td', 'c-qty', ''),
      cell('td', 'c-basic', money(sums.basic)));
    if (hasDiscount) footRow.appendChild(cell('td', 'c-disc', money(sums.disc)));
    taxCols.forEach(function (col) { footRow.appendChild(cell('td', 'c-tax', money(sums[col[0]]))); });
    footRow.appendChild(cell('td', 'c-amt', money(sums.amt)));
    node.querySelector('[data-foot]').appendChild(footRow);

    /* Below the table only what the footer cannot say: the taxable value
       when it differs from the Basic column (a discount or a deposit), the
       deposit line, the rounding, and the total. */
    const totalsBox = node.querySelector('[data-totals]');
    const rows = [];
    if (hasDiscount) rows.push(['Less discount', money(discount)]);
    if (hasDiscount || deposits > 0) rows.push(['Taxable value', money(invoice.taxable_value)]);
    if (deposits > 0) rows.push(['Deposits (no GST)', money(deposits)]);
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
    final.children[1].textContent = '₹' + Math.round(invoice.total).toLocaleString('en-IN');
    totalsBox.appendChild(final);

    area.appendChild(node);
  });

  return Promise.all(pending);
}

return { render: render };

})();
