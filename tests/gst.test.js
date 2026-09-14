'use strict';

const assert = require('assert');
const g = require('../src/shared/gst');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    console.log('  FAIL ' + name + '\n       ' + err.message);
    process.exitCode = 1;
  }
}

console.log('\nGSTIN validation');

test('accepts a GSTIN with a correct check digit', function () {
  const built = '27AAPFU0939F1Z'.slice(0, 14);
  const gstin = built + g.gstinCheckDigit(built);
  assert.strictEqual(g.validateGstin(gstin).valid, true);
});

test('rejects a single mistyped character', function () {
  const built = '23ABCDE1234F1Z'.slice(0, 14);
  const good = built + g.gstinCheckDigit(built);
  const bad = good.slice(0, 5) + (good[5] === 'X' ? 'Y' : 'X') + good.slice(6);
  assert.strictEqual(g.validateGstin(bad).valid, false);
});

test('catches the common OCR confusions 0/O and 1/I', function () {
  const built = '23ABCDE1234F1Z'.slice(0, 14);
  const good = built + g.gstinCheckDigit(built);
  const swapped = good.replace('0', 'O').replace('1', 'I');
  assert.notStrictEqual(swapped, good);
  assert.strictEqual(g.validateGstin(swapped).valid, false);
});

test('flags a state code mismatch separately', function () {
  const built = '27AAPFU0939F1Z'.slice(0, 14);
  const gstin = built + g.gstinCheckDigit(built);
  const result = g.validateGstin(gstin, '23');
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.stateMismatch, true);
});

test('rejects wrong length before anything else', function () {
  assert.strictEqual(g.validateGstin('23ABCDE').valid, false);
});

console.log('\nFinancial year');

test('September 2026 falls in FY 2026-27', function () {
  const fy = g.financialYear(new Date(2026, 8, 3));
  assert.strictEqual(fy.label, '2627');
});

test('31 March 2026 is still FY 2025-26', function () {
  assert.strictEqual(g.financialYear(new Date(2026, 2, 31)).label, '2526');
});

test('1 April 2026 rolls into FY 2026-27', function () {
  assert.strictEqual(g.financialYear(new Date(2026, 3, 1)).label, '2627');
});

console.log('\nInvoice numbering');

test('builds a padded number carrying the financial year and month', function () {
  const n = g.buildInvoiceNumber('SH', new Date(2026, 8, 3), 147);
  assert.strictEqual(n, 'SH/2627/09/0147');
  assert.ok(n.length <= 16);
});

test('a three letter prefix still fits inside the limit', function () {
  assert.ok(g.buildInvoiceNumber('SHR', new Date(2026, 8, 3), 1).length <= 16);
});

test('throws when the prefix pushes past 16 characters', function () {
  assert.throws(function () {
    g.buildInvoiceNumber('BALAJIGAS', new Date(2026, 8, 3), 147);
  }, /16 character limit/);
});

test('the period key pairs the financial year with the calendar month', function () {
  assert.strictEqual(g.periodKey(new Date(2026, 8, 3)), '2627-09');
  assert.strictEqual(g.periodKey(new Date(2026, 2, 31)), '2526-03');
});

test('the series prefix comes from the first two letters of the trade name', function () {
  assert.strictEqual(g.seriesPrefix('Shree Balaji Gas Agency'), 'SH');
  assert.strictEqual(g.seriesPrefix('  om gas'), 'OM');
  assert.strictEqual(g.seriesPrefix('123'), 'GB');
});

console.log('\nTax computation');

test('splits tax into CGST and SGST within the state', function () {
  const r = g.computeInvoice([
    { qty: 1, rate: 100, gstRate: 18 },
    { qty: 1, rate: 50, gstRate: 18 }
  ], '23', '23');
  assert.strictEqual(r.taxable, 150);
  assert.strictEqual(r.cgst, 13.5);
  assert.strictEqual(r.sgst, 13.5);
  assert.strictEqual(r.igst, 0);
  assert.strictEqual(r.total, 177);
});

test('uses IGST when the place of supply is another state', function () {
  const r = g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18 }], '23', '27');
  assert.strictEqual(r.igst, 18);
  assert.strictEqual(r.cgst, 0);
});

test('rounding line reconciles the total exactly', function () {
  const r = g.computeInvoice([{ qty: 3, rate: 236, gstRate: 18 }], '23', '23');
  assert.strictEqual(g.round2(r.beforeRounding + r.rounding), r.total);
});

test('halves an odd tax amount without losing a paisa', function () {
  const r = g.computeInvoice([{ qty: 1, rate: 55.55, gstRate: 18 }], '23', '23');
  assert.strictEqual(g.round2(r.cgst + r.sgst), g.round2(r.taxable * 0.18));
});

test('tax is broken out per rate when an invoice mixes them', function () {
  const out = g.computeInvoice([
    { description: 'Installation', qty: 1, rate: 100, gstRate: 18 },
    { description: 'Two burner hot plate', qty: 1, rate: 2000, gstRate: 28 },
    { description: 'Mechanic visit', qty: 1, rate: 200, gstRate: 18 }
  ], '23', '23');

  assert.strictEqual(out.byRate.length, 2, 'one row per distinct rate');
  assert.deepStrictEqual(out.byRate.map(function (b) { return b.rate; }), [18, 28]);

  const eighteen = out.byRate[0];
  assert.strictEqual(eighteen.taxable, 300);
  assert.strictEqual(eighteen.cgst, 27);
  assert.strictEqual(eighteen.sgst, 27);

  const twentyEight = out.byRate[1];
  assert.strictEqual(twentyEight.taxable, 2000);
  assert.strictEqual(twentyEight.cgst, 280);

  const sum = out.byRate.reduce(function (s, b) { return s + b.cgst + b.sgst; }, 0);
  assert.strictEqual(g.round2(sum), g.round2(out.cgst + out.sgst),
    'the breakup has to add back to the invoice total');
});

test('a saved invoice can be broken up again from its lines', function () {
  /* Nothing stores the breakup, so the printed copy rebuilds it from the
     saved lines. It has to agree with what was computed at save time. */
  const computed = g.computeInvoice([
    { description: 'Installation', qty: 1, rate: 100, gstRate: 18 },
    { description: 'Hot plate', qty: 1, rate: 2000, gstRate: 28 }
  ], '23', '23');

  const saved = computed.lines.map(function (l) {
    return { gst_rate: l.gstRate, line_total: l.lineTotal, tax_amount: l.taxAmount };
  });

  assert.deepStrictEqual(g.taxBreakupFromLines(saved, true), computed.byRate);
});

test('the breakup follows IGST out of state', function () {
  const out = g.computeInvoice([
    { description: 'Hot plate', qty: 1, rate: 1000, gstRate: 18 }
  ], '23', '27');
  assert.strictEqual(out.byRate[0].igst, 180);
  assert.strictEqual(out.byRate[0].cgst, 0);
});

console.log('\nAmount in words');

test('writes a plain rupee amount', function () {
  assert.strictEqual(g.amountInWords(177), 'Rupees one hundred seventy seven only');
});

test('uses the lakh scale', function () {
  assert.strictEqual(g.amountInWords(250000), 'Rupees two lakh fifty thousand only');
});

test('includes paise when present', function () {
  assert.ok(/fifty paise/.test(g.amountInWords(177.5)));
});

console.log('\nDiscount');

test('is taken off the taxable value before tax, not after', function () {
  const r = g.computeInvoice([{ qty: 1, rate: 1000, gstRate: 18 }], '23', '23', 100);
  assert.strictEqual(r.gross, 1000);
  assert.strictEqual(r.discount, 100);
  assert.strictEqual(r.taxable, 900);
  assert.strictEqual(r.cgst, 81);
  assert.strictEqual(r.sgst, 81);
  assert.strictEqual(r.total, 1062);
});

test('is apportioned across lines by gross value and sums exactly', function () {
  const r = g.computeInvoice([
    { qty: 1, rate: 200, gstRate: 18 },
    { qty: 1, rate: 2500, gstRate: 28 },
    { qty: 3, rate: 33.33, gstRate: 18 }
  ], '23', '23', 250);
  const shares = r.lines.map(function (l) { return l.discount; });
  const sum = shares.reduce(function (a, b) { return g.round2(a + b); }, 0);
  assert.strictEqual(sum, 250);
  assert.ok(shares[1] > shares[0] && shares[0] > shares[2], 'shares should follow gross value ' + shares);
  r.lines.forEach(function (l) {
    assert.strictEqual(l.lineTotal, g.round2(l.gross - l.discount));
    assert.strictEqual(l.taxAmount, g.round2(l.lineTotal * l.gstRate / 100));
  });
});

test('apportionDiscount gives the remainder to the last line', function () {
  const shares = g.apportionDiscount([10, 10, 10], 10);
  assert.deepStrictEqual(shares, [3.33, 3.33, 3.34]);
});

test('is clamped to the gross value and never negative', function () {
  assert.strictEqual(g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18 }], '23', '23', 5000).taxable, 0);
  assert.strictEqual(g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18 }], '23', '23', -40).taxable, 100);
  assert.strictEqual(g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18 }], '23', '23').discount, 0);
});

test('lines carry their own cgst/sgst so the print can fill columns', function () {
  const r = g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18 }], '23', '23');
  assert.strictEqual(r.lines[0].cgst, 9);
  assert.strictEqual(r.lines[0].sgst, 9);
  assert.strictEqual(r.lines[0].lineWithTax, 118);
  const inter = g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18 }], '23', '27');
  assert.strictEqual(inter.lines[0].igst, 18);
  assert.strictEqual(inter.lines[0].cgst, 0);
});

console.log('\nLocal date');

test('formats the local calendar date, not the UTC one', function () {
  const d = new Date(2026, 8, 12, 1, 30); // 01:30 local on 12 Sep
  assert.strictEqual(g.localDate(d), '2026-09-12');
  assert.strictEqual(g.localDate(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
});

console.log('\nInclusive pricing and deposits');

test('backs the basic value out of a GST-inclusive price and lands on it exactly', function () {
  // The circular: Rs 50 + Rs 9 = Rs 59. A distributor typing 59 as inclusive
  // must get 50 / 4.50 / 4.50, and the sample invoice's 190 tube gives 161.02.
  const r = g.computeInvoice([
    { qty: 1, rate: 59, gstRate: 18, inclusive: true },
    { qty: 1, rate: 190, gstRate: 18, inclusive: true }
  ], '23', '23');
  assert.strictEqual(r.lines[0].lineTotal, 50);
  assert.strictEqual(r.lines[0].taxAmount, 9);
  assert.strictEqual(r.lines[0].lineWithTax, 59);
  assert.strictEqual(r.lines[1].lineTotal, 161.02);
  assert.strictEqual(r.lines[1].taxAmount, 28.98);
  assert.strictEqual(r.lines[1].lineWithTax, 190);
  assert.strictEqual(r.cgst, 18.99);
  assert.strictEqual(r.sgst, 18.99);
  assert.strictEqual(r.beforeRounding, 249);
});

test('an inclusive price with an awkward split still totals the quoted price', function () {
  const r = g.computeInvoice([{ qty: 1, rate: 100, gstRate: 18, inclusive: true }], '23', '23');
  assert.strictEqual(r.lines[0].lineTotal, 84.75);
  assert.strictEqual(r.lines[0].taxAmount, 15.25);
  assert.strictEqual(r.lines[0].lineWithTax, 100);
});

test('a deposit is in the total but outside taxable value, tax and discount', function () {
  const r = g.computeInvoice([
    { qty: 1, rate: 59, gstRate: 18, inclusive: true },
    { qty: 1, rate: 258.58, gstRate: 0, nonGst: true },
    { qty: 1, rate: 190, gstRate: 18, inclusive: true }
  ], '23', '23', 10);
  assert.strictEqual(r.nonGst, 258.58);
  assert.strictEqual(r.lines[1].discount, 0);
  assert.strictEqual(r.lines[1].taxAmount, 0);
  assert.strictEqual(r.taxable, g.round2(50 + 161.02 - 10));
  assert.strictEqual(r.byRate.length, 1, 'deposit must not create a 0% bucket');
  assert.strictEqual(r.beforeRounding, g.round2(r.taxable + r.cgst + r.sgst + 258.58));
});

test('the sample distributor invoice reproduces to the paisa', function () {
  // DGCC 59 incl, deposit 258.58, tube 190 incl → total 507.58, CGST/SGST 18.99.
  const r = g.computeInvoice([
    { qty: 1, rate: 59, gstRate: 18, inclusive: true },
    { qty: 1, rate: 258.58, nonGst: true },
    { qty: 1, rate: 190, gstRate: 18, inclusive: true }
  ], '23', '23');
  assert.strictEqual(r.beforeRounding, 507.58);
  assert.strictEqual(r.cgst, 18.99);
  assert.strictEqual(r.sgst, 18.99);
  assert.strictEqual(r.total, 508);
});

test('taxBreakupFromLines skips deposit lines', function () {
  const b = g.taxBreakupFromLines([
    { gst_rate: 18, line_total: 100, tax_amount: 18 },
    { gst_rate: 0, line_total: 500, tax_amount: 0, non_gst: 1 }
  ], true);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].taxable, 100);
});

console.log('\nState from the GSTIN');

test('validateGstin names the state', function () {
  const r = g.validateGstin('24ABQPZ7781K1ZJ', null);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.stateCode, '24');
  assert.strictEqual(r.stateName, 'Gujarat');
  assert.strictEqual(g.stateName('23'), 'Madhya Pradesh');
  assert.strictEqual(g.stateName('99'), null);
});

console.log('\n' + passed + ' passed\n');
