'use strict';

const assert = require('assert');
const t = require('../src/main/tabular');

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

console.log('\nHeader row detection');

// What a distributor portal actually exports: a title, the agency, a date
// range, a blank row, then the headings in row 5.
const PORTAL = [
  ['LIST OF CONSUMERS', '', '', ''],
  ['SHREE BHARAT GAS AGENCY, GONDAL', '', '', ''],
  ['As on 01/09/2026', '', '', ''],
  ['', '', '', ''],
  ['Cons. No.', 'Consumer Name', 'Address', 'Mobile No.'],
  ['65767001', 'SAPNA PANCHAL', '12 Station Road, Gondal', '9876543210'],
  ['65767002', 'RAMESH PATEL', '4 Market Lane, Gondal', '9812345678'],
  ['65767003', 'KIRAN SHAH', '9 NH Road, Gondal', '9765432109']
];

test('finds headings in row 5, not row 1', function () {
  const r = t.readMatrix(PORTAL);
  assert.strictEqual(r.headerRow, 5);
  assert.deepStrictEqual(r.headers, ['Cons. No.', 'Consumer Name', 'Address', 'Mobile No.']);
  assert.strictEqual(r.rows.length, 3, 'title rows must not become data');
  assert.strictEqual(r.rows[0]['Consumer Name'], 'SAPNA PANCHAL');
});

test('maps every field from those headings', function () {
  const g = t.readMatrix(PORTAL).guess;
  assert.strictEqual(g.consumer_no, 'Cons. No.');
  assert.strictEqual(g.name, 'Consumer Name');
  assert.strictEqual(g.address, 'Address');
  assert.strictEqual(g.mobile, 'Mobile No.');
});

test('still handles a plain file with headings in row 1', function () {
  const r = t.readMatrix([
    ['Consumer No', 'Name', 'Address', 'Mobile'],
    ['100001', 'Test One', 'Lane 1', '9999999999']
  ]);
  assert.strictEqual(r.headerRow, 1);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.guess.consumer_no, 'Consumer No');
});

test('reads the data when there is no heading row at all', function () {
  const r = t.readMatrix([
    ['65767001', 'SAPNA PANCHAL', '12 Station Road', '9876543210'],
    ['65767002', 'RAMESH PATEL', '4 Market Lane', '9812345678'],
    ['65767003', 'KIRAN SHAH', '9 NH Road', '9765432109'],
    ['65767004', 'ANITA DESAI', '7 Old Market', '9711111111']
  ]);
  assert.strictEqual(r.headerRow, -1);
  assert.strictEqual(r.rows.length, 4, 'no row may be eaten as a header');
  assert.deepStrictEqual(r.headers, ['Column A', 'Column B', 'Column C', 'Column D']);
  assert.strictEqual(r.guess.mobile, 'Column D', 'ten-digit numbers starting 6-9 are mobiles');
  assert.strictEqual(r.guess.consumer_no, 'Column A');
  assert.strictEqual(r.guess.name, 'Column B');
});

test('an exact heading beats a loose one for the same column', function () {
  const r = t.readMatrix([
    ['Consumer Name', 'Consumer No', 'Mobile'],
    ['SAPNA PANCHAL', '65767001', '9876543210'],
    ['RAMESH PATEL', '65767002', '9812345678']
  ]);
  assert.strictEqual(r.guess.name, 'Consumer Name');
  assert.strictEqual(r.guess.consumer_no, 'Consumer No');
});

test('blank and duplicate headings get usable names', function () {
  const r = t.readMatrix([
    ['Consumer No', '', 'Name', 'Name'],
    ['100001', 'x', 'Test One', 'Also One']
  ]);
  assert.deepStrictEqual(r.headers, ['Consumer No', 'Column B', 'Name', 'Name (2)']);
  assert.strictEqual(r.rows[0]['Name (2)'], 'Also One');
});

test('blank rows between data are dropped, not imported empty', function () {
  const r = t.readMatrix([
    ['Consumer No', 'Name'],
    ['100001', 'Test One'],
    ['', ''],
    ['100002', 'Test Two']
  ]);
  assert.strictEqual(r.rows.length, 2);
});

test('a banner of repeated words is not mistaken for headings', function () {
  const r = t.readMatrix([
    ['Report', 'Report', 'Report'],
    ['Consumer No', 'Name', 'Mobile'],
    ['100001', 'Test One', '9876543210'],
    ['100002', 'Test Two', '9812345678']
  ]);
  assert.strictEqual(r.headerRow, 2);
});

test('an empty sheet says so instead of throwing', function () {
  const r = t.readMatrix([]);
  assert.deepStrictEqual(r.headers, []);
  assert.deepStrictEqual(r.rows, []);
});

console.log('\n' + passed + ' passed\n');
