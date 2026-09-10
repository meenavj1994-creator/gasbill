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

console.log('\n' + passed + ' passed\n');
