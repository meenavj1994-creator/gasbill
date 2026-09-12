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
  assert.ok(/could not be read reliably/.test(r.reason));
});

test('repairs the OCR confusions a scan actually produced', function () {
  // Verbatim from Tesseract on a 200dpi JPEG of the fixture: Z read as 7,
  // and a space dropped in before the last three characters.
  const scanned = REG06.replace(GOOD, '23ABCDE1234F 178');
  const r = cert.parseCertificate(scanned, { expectedStateCode: '23' });
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.strictEqual(r.fields.gstin, GOOD);
});

test('repairs class-fixed positions only, never the check character', function () {
  assert.strictEqual(cert.repairGstin('23ABCDE1234F178'), '23ABCDE1234F1Z8');
  assert.strictEqual(cert.repairGstin('Z3ABCDE1Z34F1Z8'), '23ABCDE1234F1Z8');
  assert.strictEqual(cert.repairGstin('23A8CDE1234F1Z8'), '23ABCDE1234F1Z8');
  // The check character is left as read, so a wrong one still fails.
  const wrongCheck = GOOD.slice(0, 14) + (GOOD[14] === 'A' ? 'B' : 'A');
  assert.strictEqual(cert.repairGstin(wrongCheck), wrongCheck);
  assert.strictEqual(cert.parseCertificate(REG06.replace(GOOD, wrongCheck), { expectedStateCode: '23' }).ok, false);
  assert.strictEqual(cert.repairGstin('TOO-SHORT'), null);
});

test('still returns the names and address when the GSTIN is unreadable', function () {
  const broken = REG06.replace(GOOD, 'XXXXXXXXXXXXXXX');
  const r = cert.parseCertificate(broken, { expectedStateCode: '23' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.fields.trade_name, 'Shree Balaji Gas Agency');
  assert.ok(/type the GSTIN/i.test(r.reason));
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

test('the month period covers the whole calendar month', function () {
  const p = reports.periodForMonth(new Date(2026, 8, 15));
  assert.strictEqual(p.from, '2026-09-01');
  assert.strictEqual(p.to, '2026-09-30');
  assert.strictEqual(p.label, '2026-09');
});

test('period ends are not dragged back a day by the timezone', function () {
  /* Building these from local midnight and running them through
     toISOString() lands on the previous day anywhere east of UTC, which took
     31 March out of the financial year it belongs to. */
  assert.strictEqual(reports.periodForFinancialYear(new Date(2026, 8, 3)).to, '2027-03-31');
  assert.strictEqual(reports.periodForMonth(new Date(2026, 1, 10)).to, '2026-02-28');
  assert.strictEqual(reports.periodForMonth(new Date(2026, 0, 1)).from, '2026-01-01');
});

test('merging two machines interleaves them by date', function () {
  const merged = reports.mergeInvoices([
    { source: 'SH', invoices: [
      { invoice_no: 'SH/2627/09/0001', invoice_date: '2026-09-03', customer_name: 'A' },
      { invoice_no: 'SH/2627/09/0002', invoice_date: '2026-09-09', customer_name: 'B' }
    ] },
    { source: 'SB', invoices: [
      { invoice_no: 'SB/2627/09/0001', invoice_date: '2026-09-05', customer_name: 'C' }
    ] }
  ]);

  assert.deepStrictEqual(merged.invoices.map(function (i) { return i.customer_name; }),
    ['A', 'C', 'B']);
  assert.deepStrictEqual(merged.invoices.map(function (i) { return i.source; }),
    ['SH', 'SB', 'SH']);
  assert.strictEqual(merged.duplicates.length, 0);
});

test('two machines sharing a prefix are caught as duplicates', function () {
  /* Exactly the failure this is here to catch: both machines set up with the
     same prefix, each counting from 0001 in its own database. */
  const merged = reports.mergeInvoices([
    { source: 'SH', invoices: [
      { invoice_no: 'SH/2627/09/0001', invoice_date: '2026-09-03', customer_name: 'Ramesh' }
    ] },
    { source: 'SH', invoices: [
      { invoice_no: 'SH/2627/09/0001', invoice_date: '2026-09-04', customer_name: 'Sunita' }
    ] }
  ]);

  assert.strictEqual(merged.invoices.length, 2, 'both invoices are still reported');
  assert.strictEqual(merged.duplicates.length, 1);
  assert.strictEqual(merged.duplicates[0]['Invoice no'], 'SH/2627/09/0001');
  assert.strictEqual(merged.duplicates[0]['Customer'], 'Sunita');
});

test('the register names the machine each invoice came from', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31')
    .map(function (inv) { return Object.assign({ source: 'SH' }, inv); });
  const rows = reports.invoiceRegister(invoices);
  assert.strictEqual(rows[0].Machine, 'SH');
});

test('a workbook only grows a duplicates sheet when there are duplicates', function () {
  const invoices = seededRepo().invoicesBetween('2026-04-01', '2027-03-31');
  const names = [];
  const XLSXStub = {
    utils: {
      book_new: function () { return {}; },
      json_to_sheet: function (rows) { return rows; },
      book_append_sheet: function (wb, sheet, name) { names.push(name); }
    }
  };

  reports.buildWorkbook(XLSXStub, { invoices: invoices, creditNotes: [] });
  assert.ok(names.indexOf('DUPLICATE NUMBERS') < 0, 'clean export should not carry the sheet');

  names.length = 0;
  reports.buildWorkbook(XLSXStub, {
    invoices: invoices,
    creditNotes: [],
    duplicates: [{ 'Invoice no': 'SH/2627/09/0001' }]
  });
  assert.strictEqual(names[0], 'DUPLICATE NUMBERS', 'it should lead the workbook');
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
