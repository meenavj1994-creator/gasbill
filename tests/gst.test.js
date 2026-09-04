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

test('builds a padded number within the 16 character limit', function () {
  const n = g.buildInvoiceNumber('BG', new Date(2026, 8, 3), 147);
  assert.strictEqual(n, 'BG/2627/00147');
  assert.ok(n.length <= 16);
});

test('throws when the prefix pushes past 16 characters', function () {
  assert.throws(function () {
    g.buildInvoiceNumber('BALAJIGAS', new Date(2026, 8, 3), 147);
  }, /16 character limit/);
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
