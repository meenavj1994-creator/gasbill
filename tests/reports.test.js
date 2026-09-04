'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { migrate } = require('../src/main/migrations');
const { createRepository } = require('../src/main/repository');
const cert = require('../src/main/certificate');
const reports = require('../src/main/reports');
const gst = require('../src/shared/gst');

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

function validGstin(prefix) {
  const base = (prefix + 'ABCDE1234F1Z').slice(0, 14);
  return base + gst.gstinCheckDigit(base);
}

const GOOD = validGstin('23');

const REG06 = [
  'Form GST REG-06',
  'Registration Certificate',
  'Registration Number : ' + GOOD,
  '1. Legal Name of Business',
  'RAJESH KUMAR AGRAWAL',
  '2. Trade Name, if any',
  'Shree Balaji Gas Agency',
  '3. Constitution of Business',
  'Proprietorship',
  '4. Address of Principal Place of Business',
  '45, Freeganj Main Road, Ujjain, Madhya Pradesh, 456001',
  '5. Date of Liability 01/07/2017'
].join('\n');

console.log('\nCertificate parsing');

test('pulls the fields out of a REG-06 text layer', function () {
  const r = cert.parseCertificate(REG06, { expectedStateCode: '23' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fields.gstin, GOOD);
  assert.strictEqual(r.fields.legal_name, 'RAJESH KUMAR AGRAWAL');
  assert.strictEqual(r.fields.trade_name, 'Shree Balaji Gas Agency');
  assert.ok(/Freeganj/.test(r.fields.address));
});

test('rejects a GSTIN whose check digit was misread', function () {
  const broken = REG06.replace(GOOD, GOOD.slice(0, 14) + (GOOD[14] === 'A' ? 'B' : 'A'));
  const r = cert.parseCertificate(broken, { expectedStateCode: '23' });
  assert.strictEqual(r.ok, false);
  assert.ok(/check digit/.test(r.reason));
});

test('skips a GSTIN from the wrong state and reports failure', function () {
  const other = REG06.replace(GOOD, validGstin('27'));
  const r = cert.parseCertificate(other, { expectedStateCode: '23' });
  assert.strictEqual(r.ok, false);
});

test('says so plainly when OCR returned nothing usable', function () {
  const r = cert.parseCertificate('   \n  \n ', { expectedStateCode: '23' });
  assert.strictEqual(r.ok, false);
  assert.ok(/manually/.test(r.reason));
});

test('reports which labelled fields were missed', function () {
  const partial = 'Registration Number : ' + GOOD + '\nSome other text that pads the length out nicely here.';
  const r = cert.parseCertificate(partial, { expectedStateCode: '23' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.missing.indexOf('trade_name') >= 0);
});

console.log('\nReports');

function seededRepo() {
  const db = new Database(':memory:');
  migrate(db);
  const repo = createRepository(db);
  repo.saveDistributor({
    trade_name: 'Shree Balaji Gas Agency', legal_name: 'Rajesh Kumar Agrawal',
    address: 'Ujjain', gstin: GOOD, state_code: '23', phone: null,
    logo_path: null, certificate_path: null, series_prefix: 'BG',
    backup_folder: null, setup_complete: 1
  });

  const line = function (desc, rate) {
    return { description: desc, qty: 1, rate: rate, gstRate: 18 };
  };

  repo.saveInvoice({
    customer_name: 'Ramesh Sharma', consumer_no: '1103400012',
    invoice_date: '2026-04-10', lines: [line('Installation', 100), line('DGCC', 50)]
  });
  repo.saveInvoice({
    customer_name: 'Sunita Verma', consumer_no: '1103400013',
    invoice_date: '2026-05-02', lines: [line('Mandatory inspection', 200)]
  });
  repo.saveInvoice({
    customer_name: 'Ujjain Caterers', customer_gstin: validGstin('23'),
    invoice_date: '2026-05-20', lines: [line('Mechanic visit', 200)]
  });

  return repo;
}

test('the register lists every invoice and tags B2B correctly', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31');
  const rows = reports.invoiceRegister(invoices);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows.filter(function (r) { return r.Type === 'B2B'; }).length, 1);
});

test('B2CS excludes B2B invoices', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31');
  const b2cs = reports.b2csSummary(invoices);
  assert.strictEqual(b2cs.length, 1);
  assert.strictEqual(b2cs[0]['Taxable value'], 350);
  assert.strictEqual(b2cs[0]['Invoice count'], 2);
});

test('B2CS and B2B taxable values add back to the register total', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31');
  const registerTotal = reports.invoiceRegister(invoices)
    .reduce(function (sum, r) { return sum + r['Taxable value']; }, 0);
  const b2csTotal = reports.b2csSummary(invoices)
    .reduce(function (sum, r) { return sum + r['Taxable value']; }, 0);
  const b2bTotal = reports.b2bDetail(invoices)
    .reduce(function (sum, r) { return sum + r['Taxable value']; }, 0);
  assert.strictEqual(gst.round2(b2csTotal + b2bTotal), gst.round2(registerTotal));
});

test('charge summary aggregates by description across invoices', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31');
  const summary = reports.chargeSummary(invoices);
  assert.strictEqual(summary.length, 4);
  const total = summary.reduce(function (sum, r) { return sum + r['Taxable value']; }, 0);
  assert.strictEqual(total, 550);
  const installation = summary.find(function (r) { return r.Description === 'Installation'; });
  assert.strictEqual(installation['Taxable value'], 100);
});

test('monthly totals split by month and reconcile', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31');
  const months = reports.monthlyTotals(invoices);
  assert.deepStrictEqual(months.map(function (m) { return m.Month; }), ['2026-04', '2026-05']);
  const sum = months.reduce(function (s, m) { return s + m.Total; }, 0);
  const invSum = invoices.reduce(function (s, i) { return s + i.total; }, 0);
  assert.strictEqual(gst.round2(sum), gst.round2(invSum));
});

test('a period with no invoices produces empty sheets, not a crash', function () {
  const invoices = seededRepo().invoicesBetween('2020-01-01', '2020-12-31');
  assert.strictEqual(reports.invoiceRegister(invoices).length, 0);
  assert.strictEqual(reports.b2csSummary(invoices).length, 0);
  assert.strictEqual(reports.monthlyTotals(invoices).length, 0);
});

test('the FY period covers April to March', function () {
  const p = reports.periodForFinancialYear(new Date(2026, 8, 3));
  assert.strictEqual(p.from, '2026-04-01');
  assert.strictEqual(p.label, '2627');
});

console.log('\n' + passed + ' passed\n');
