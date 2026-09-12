'use strict';

/* Builds the two printed copies of an invoice into #print-area. Used by the
   billing screen straight after save, and by the Invoices page for reprints,
   so both produce the identical document. Needs print.css on the page. */

const Printable = (function () {

const TEMPLATE = `
  <article class="doc">
    <div class="doc-head">
      <div class="doc-title">Tax invoice</div>
      <div class="doc-copy" data-copy></div>
    </div>
    <div class="doc-supplier">
      <img class="doc-logo" data-logo hidden />
      <div class="doc-supplier-text">
        <div class="doc-supplier-name" data-trade-name></div>
        <div data-supplier-address></div>
        <div class="doc-mono">GSTIN <span data-supplier-gstin></span></div>
      </div>
      <div class="doc-meta">
        <div><span class="doc-label">Invoice no</span><span class="doc-mono" data-invoice-no></span></div>
        <div><span class="doc-label">Date</span><span class="doc-mono" data-invoice-date></span></div>
      </div>
    </div>
    <div class="doc-recipient">
      <div class="doc-recipient-who">
        <div class="doc-label">Recipient</div>
        <div data-customer-name></div>
        <div data-customer-address></div>
        <div data-consumer-line></div>
        <div data-customer-gstin-line></div>
      </div>
      <div class="doc-recipient-supply">
        <div class="doc-label">Supply</div>
        <div data-place-of-supply></div>
        <div>Reverse charge — No</div>
      </div>
    </div>
    <table class="doc-lines">
      <thead data-head></thead>
      <tbody data-lines></tbody>
      <tfoot data-foot></tfoot>
    </table>
    <div class="doc-summary">
      <div class="doc-totals" data-totals></div>
      <div class="doc-words" data-words></div>
      <div class="doc-thanks" data-thanks>Thank you for your business.</div>
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

function render(invoice, distributor) {
  const area = document.getElementById('print-area');
  area.innerHTML = '';

  ['Original for recipient', 'Duplicate for supplier'].forEach(function (copyLabel) {
    const node = templateNode();
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
       line, and the bottom block stays short however many rates mix.

       Basic is the line amount before tax. A Discount column exists only on
       invoices that carry one: each line's tax is computed on Basic less its
       share, so without the column the 9% beside it would not reconcile. */
    const intra = !(invoice.igst > 0);
    const discount = Number(invoice.discount) || 0;
    const hasDiscount = discount > 0;
    const taxCols = intra ? [['cgst', 'CGST (%)'], ['sgst', 'SGST (%)']] : [['igst', 'IGST (%)']];
    const table = node.querySelector('.doc-lines');
    table.classList.add(intra ? 'doc-lines-intra' : 'doc-lines-inter');
    if (hasDiscount) table.classList.add('doc-lines-disc');

    const cell = function (tag, cls, text) {
      const el = document.createElement(tag);
      el.className = cls;
      el.textContent = text;
      return el;
    };
    const small = function (text) {
      const span = document.createElement('span');
      span.className = 'doc-pct';
      span.textContent = text;
      return span;
    };
    const taxCell = function (rate, amount) {
      const td = cell('td', 'c-tax', '');
      td.append(small(rate + '%'), document.createTextNode(money(amount)));
      return td;
    };

    const headRow = document.createElement('tr');
    headRow.append(cell('th', 'c-desc', 'Description'), cell('th', 'c-qty', 'Qty'),
      cell('th', 'c-basic', 'Basic'));
    if (hasDiscount) headRow.appendChild(cell('th', 'c-disc', 'Discount'));
    taxCols.forEach(function (col) { headRow.appendChild(cell('th', 'c-tax', col[1])); });
    headRow.appendChild(cell('th', 'c-amt', 'Total'));
    node.querySelector('[data-head]').appendChild(headRow);

    const sums = { basic: 0, disc: 0, cgst: 0, sgst: 0, igst: 0, amt: 0 };
    const body = node.querySelector('[data-lines]');
    for (const line of invoice.lines) {
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
      tr.append(cell('td', 'c-desc', line.description), cell('td', 'c-qty', String(line.qty)), basicCell);
      if (hasDiscount) tr.appendChild(cell('td', 'c-disc', money(lineDisc)));
      taxCols.forEach(function (col) { tr.appendChild(taxCell(rate / taxCols.length, parts[col[0]])); });
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
    footRow.append(cell('td', 'c-desc', 'Total'), cell('td', 'c-qty', ''),
      cell('td', 'c-basic', money(sums.basic)));
    if (hasDiscount) footRow.appendChild(cell('td', 'c-disc', money(sums.disc)));
    taxCols.forEach(function (col) { footRow.appendChild(cell('td', 'c-tax', money(sums[col[0]]))); });
    footRow.appendChild(cell('td', 'c-amt', money(sums.amt)));
    node.querySelector('[data-foot]').appendChild(footRow);

    const totalsBox = node.querySelector('[data-totals]');
    const rows = [['Basic', money(invoice.taxable_value + discount)]];
    if (hasDiscount) {
      rows.push(['Less discount', money(discount)]);
      rows.push(['Taxable value', money(invoice.taxable_value)]);
    }
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

return { render: render };

})();
