'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { migrate } = require('../src/main/migrations');
const { createRepository } = require('../src/main/repository');

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

function freshRepo() {
  const db = new Database(':memory:');
  migrate(db);
  const repo = createRepository(db);
  repo.saveDistributor({
    trade_name: 'Shree Balaji Gas Agency',
    legal_name: 'Shree Balaji Gas Agency',
    address: '45, Freeganj Main Road, Ujjain, MP 456001',
    gstin: '23ABCDE1234F1Z5',
    state_code: '23',
    phone: '0734-2510000',
    logo_path: null,
    certificate_path: null,
    series_prefix: 'SH',
    backup_folder: null,
    setup_complete: 1
  });
  return { db, repo };
}

const LINES = [
  { description: 'Installation and demonstration', qty: 1, rate: 100, gstRate: 18 },
  { description: 'DGCC issuance charges', qty: 1, rate: 50, gstRate: 18 }
];

function customer(extra) {
  return Object.assign({
    consumer_no: '1103400012',
    customer_name: 'Ramesh Chandra Sharma',
    customer_address: '12, Nanakheda, Ujjain, MP 456010',
    lines: LINES
  }, extra || {});
}

console.log('\nMigrations');

test('applies cleanly and is idempotent', function () {
  const { migrations } = require('../src/main/migrations');
  const latest = migrations[migrations.length - 1].version;
  const db = new Database(':memory:');
  const first = migrate(db);
  const second = migrate(db);
  assert.strictEqual(first.from, 0);
  assert.strictEqual(first.to, latest);
  assert.strictEqual(second.from, second.to);
});

console.log('\nInvoice numbering');

test('numbers run consecutively with no gaps', function () {
  const { repo } = freshRepo();
  const numbers = [];
  for (let i = 0; i < 5; i++) {
    numbers.push(repo.saveInvoice(customer({ invoice_date: '2026-09-03' })).invoice_no);
  }
  assert.deepStrictEqual(numbers, [
    'SH/2627/09/0001', 'SH/2627/09/0002', 'SH/2627/09/0003', 'SH/2627/09/0004', 'SH/2627/09/0005'
  ]);
});

test('counter restarts in a new month', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-09-28' }));
  const lastOfMonth = repo.saveInvoice(customer({ invoice_date: '2026-09-30' }));
  const firstOfNext = repo.saveInvoice(customer({ invoice_date: '2026-10-01' }));
  assert.strictEqual(lastOfMonth.invoice_no, 'SH/2627/09/0002');
  assert.strictEqual(firstOfNext.invoice_no, 'SH/2627/10/0001');
});

test('counter restarts in a new financial year', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-03-30' }));
  const lastOfOldFy = repo.saveInvoice(customer({ invoice_date: '2026-03-31' }));
  const firstOfNewFy = repo.saveInvoice(customer({ invoice_date: '2026-04-01' }));
  assert.strictEqual(lastOfOldFy.invoice_no, 'SH/2526/03/0002');
  assert.strictEqual(firstOfNewFy.invoice_no, 'SH/2627/04/0001');
});

test('a failed save does not consume a number', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  try {
    repo.saveInvoice(customer({ invoice_date: '2026-09-03', customer_name: null }));
  } catch (e) { /* expected */ }
  const next = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  assert.strictEqual(next.invoice_no, 'SH/2627/09/0002');
});

test('invoice_no is unique at the database level', function () {
  const { db, repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  assert.throws(function () {
    db.prepare(`INSERT INTO invoices (invoice_no, fy_label, invoice_date, customer_name,
      place_of_supply, place_of_supply_code, taxable_value, total, amount_in_words, created_at)
      VALUES (?, '2627', '2026-09-03', 'Duplicate', 'Madhya Pradesh', '23', 1, 1, 'x', 'x')`)
      .run(inv.invoice_no);
  }, /UNIQUE/);
});

console.log('\nInvoice contents');

test('stores the CGST and SGST split and the words', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  assert.strictEqual(inv.taxable_value, 150);
  assert.strictEqual(inv.cgst, 13.5);
  assert.strictEqual(inv.sgst, 13.5);
  assert.strictEqual(inv.igst, 0);
  assert.strictEqual(inv.total, 177);
  assert.strictEqual(inv.amount_in_words, 'Rupees one hundred seventy seven only');
  assert.strictEqual(inv.lines.length, 2);
});

console.log('\nCharge versioning');

test('revising a rate deactivates the old row and keeps it', function () {
  const { repo } = freshRepo();
  const original = repo.addCharge({
    description: 'Visit and admin charges',
    base_amount: 75, gst_rate: 18, effective_from: '2018-04-01'
  });
  const revised = repo.reviseCharge(original.id, { base_amount: 100, effective_from: '2019-09-01' });

  const all = repo.allCharges();
  const old = all.find(function (c) { return c.id === original.id; });

  assert.strictEqual(old.is_active, 0);
  assert.strictEqual(old.base_amount, 75);
  assert.strictEqual(old.superseded_on, '2019-09-01');
  assert.strictEqual(revised.base_amount, 100);
  assert.strictEqual(revised.replaces_id, original.id);
  assert.strictEqual(repo.activeCharges().length, 1);
});

test('a past invoice is untouched when the rate later changes', function () {
  const { repo } = freshRepo();
  const charge = repo.addCharge({
    description: 'Mandatory inspection',
    base_amount: 200, gst_rate: 18, effective_from: '2019-09-01'
  });
  const inv = repo.saveInvoice(customer({
    invoice_date: '2026-09-03',
    lines: [{ description: charge.description, qty: 1, rate: charge.base_amount, gstRate: 18 }]
  }));

  repo.reviseCharge(charge.id, { base_amount: 350, effective_from: '2026-10-01' });

  const reread = repo.getInvoice(inv.id);
  assert.strictEqual(reread.lines[0].rate, 200);
  assert.strictEqual(reread.total, 236);
});

console.log('\nProducts and sets');

test('a product is stored and read back as one', function () {
  const { repo } = freshRepo();
  const hob = repo.addCharge({
    description: 'Two burner hot plate', base_amount: 2400, gst_rate: 18,
    effective_from: '2026-04-01', kind: 'product'
  });
  assert.strictEqual(hob.kind, 'product');
  assert.strictEqual(repo.addCharge({
    description: 'Visit charges', base_amount: 100, gst_rate: 18, effective_from: '2026-04-01'
  }).kind, 'service', 'anything not said to be a product stays a service');
});

test('revising a product keeps it a product', function () {
  const { repo } = freshRepo();
  const hose = repo.addCharge({
    description: 'Suraksha hose', base_amount: 190, gst_rate: 18,
    effective_from: '2026-04-01', kind: 'product'
  });
  const revised = repo.reviseCharge(hose.id, { base_amount: 220, effective_from: '2026-10-01' });
  assert.strictEqual(revised.kind, 'product');
});

test('a set resolves to the charges it names', function () {
  const { repo } = freshRepo();
  repo.addCharge({ description: 'Installation', base_amount: 100, gst_rate: 18, effective_from: '2026-04-01' });
  repo.addCharge({ description: 'Suraksha hose', base_amount: 190, gst_rate: 18, effective_from: '2026-04-01', kind: 'product' });

  const set = repo.saveBundle({
    name: 'New connection',
    items: [{ description: 'Installation', qty: 1 }, { description: 'Suraksha hose', qty: 2 }]
  });

  const out = repo.resolveBundle(set.id);
  assert.strictEqual(out.missing.length, 0);
  assert.deepStrictEqual(out.resolved.map(function (r) { return r.charge.description; }),
    ['Installation', 'Suraksha hose']);
  assert.strictEqual(out.resolved[1].qty, 2, 'the quantity travels with the set');
});

test('a set follows a revised rate rather than the old one', function () {
  const { repo } = freshRepo();
  const charge = repo.addCharge({
    description: 'Installation', base_amount: 100, gst_rate: 18, effective_from: '2026-04-01'
  });
  repo.saveBundle({ name: 'New connection', items: [{ description: 'Installation', qty: 1 }] });
  repo.reviseCharge(charge.id, { base_amount: 250, effective_from: '2026-10-01' });

  const out = repo.resolveBundle(repo.listBundles()[0].id);
  assert.strictEqual(out.resolved[0].charge.base_amount, 250,
    'revising a charge makes a new row, so a set keyed on id would have gone stale');
});

test('a set reports items it can no longer find', function () {
  const { repo } = freshRepo();
  repo.saveBundle({ name: 'New connection', items: [{ description: 'Gone missing', qty: 1 }] });
  const out = repo.resolveBundle(repo.listBundles()[0].id);
  assert.strictEqual(out.resolved.length, 0);
  assert.deepStrictEqual(out.missing, ['Gone missing']);
});

test('the seeded new-connection set resolves against the seeded charges', function () {
  const { repo } = freshRepo();
  const { seedCharges, seedBundles } = require('../src/main/seed');
  seedCharges(repo);
  seedBundles(repo);

  const sets = repo.listBundles();
  assert.strictEqual(sets.length, 1);
  assert.strictEqual(sets[0].name, 'New connection');

  const out = repo.resolveBundle(sets[0].id);
  assert.deepStrictEqual(out.missing, [],
    'every seeded set item must name a charge that is actually seeded');
  assert.strictEqual(out.resolved.length, 3);
});

test('seeding twice does not stack duplicate sets', function () {
  const { repo } = freshRepo();
  const { seedCharges, seedBundles } = require('../src/main/seed');
  seedCharges(repo);
  seedBundles(repo);
  seedBundles(repo);
  assert.strictEqual(repo.listBundles().length, 1);
});

test('saving a set again replaces its items instead of doubling them', function () {
  const { repo } = freshRepo();
  repo.addCharge({ description: 'Installation', base_amount: 100, gst_rate: 18, effective_from: '2026-04-01' });
  const set = repo.saveBundle({ name: 'New connection', items: [{ description: 'Installation', qty: 1 }] });
  repo.saveBundle({ id: set.id, name: 'New connection', items: [{ description: 'Installation', qty: 3 }] });

  const bundles = repo.listBundles();
  assert.strictEqual(bundles.length, 1);
  assert.strictEqual(bundles[0].items.length, 1);
  assert.strictEqual(bundles[0].items[0].qty, 3);
});

console.log('\nConsumer import');

test('upserts on consumer number and counts correctly', function () {
  const { repo } = freshRepo();
  const first = repo.importConsumers([
    { consumer_no: '1103400012', name: 'Ramesh Chandra Sharma', address: 'Nanakheda', mobile: '9876543210' },
    { consumer_no: '1103400013', name: 'Sunita Verma', address: 'Freeganj', mobile: '9876543211' },
    { consumer_no: '', name: 'No number', address: '', mobile: '' }
  ]);
  assert.deepStrictEqual(first, { created: 2, updated: 0, skipped: 1 });

  const second = repo.importConsumers([
    { consumer_no: '1103400012', name: 'Ramesh C Sharma', address: 'Nanakheda Ujjain', mobile: '9876543210' }
  ]);
  assert.deepStrictEqual(second, { created: 0, updated: 1, skipped: 0 });
  assert.strictEqual(repo.findConsumer('1103400012').name, 'Ramesh C Sharma');
});

test('lookup tolerates surrounding whitespace', function () {
  const { repo } = freshRepo();
  repo.importConsumers([{ consumer_no: '1103400012', name: 'Ramesh', address: '', mobile: '' }]);
  assert.ok(repo.findConsumer('  1103400012  '));
});

console.log('\nConsumer search');

test('search matches on number prefix and on name', function () {
  const { repo } = freshRepo();
  repo.importConsumers([
    { consumer_no: '1103400012', name: 'Ramesh Chandra Sharma', address: 'Nanakheda', mobile: '' },
    { consumer_no: '1103400013', name: 'Sunita Verma', address: 'Freeganj', mobile: '' },
    { consumer_no: '2203400014', name: 'Ramesh Patel', address: 'Mahakal', mobile: '' }
  ]);
  assert.strictEqual(repo.searchConsumers('11034').length, 2);
  assert.strictEqual(repo.searchConsumers('ramesh').length, 2);
  assert.strictEqual(repo.searchConsumers('Verma')[0].consumer_no, '1103400013');
  assert.strictEqual(repo.searchConsumers('').length, 0);
});

test('number prefix matches rank above name matches', function () {
  const { repo } = freshRepo();
  repo.importConsumers([
    { consumer_no: '9990001111', name: 'Aaa Person', address: '', mobile: '' },
    { consumer_no: '1110009999', name: 'Zzz Person', address: '', mobile: '' }
  ]);
  assert.strictEqual(repo.searchConsumers('999')[0].consumer_no, '9990001111');
});

test('respects the result limit', function () {
  const { repo } = freshRepo();
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ consumer_no: '55500000' + i, name: 'Person ' + i, address: '', mobile: '' });
  repo.importConsumers(many);
  assert.strictEqual(repo.searchConsumers('555', 6).length, 6);
});



console.log('\nAcknowledgement text');

test('a default acknowledgement is stored when none is given', function () {
  const { repo } = freshRepo();
  const d = repo.getDistributor();
  assert.ok(d.ack_text && d.ack_text.length > 40, 'ack_text was empty');
  assert.ok(/received the original/.test(d.ack_text));
});

test('a custom acknowledgement is kept', function () {
  const { repo } = freshRepo();
  const d = repo.getDistributor();
  d.ack_text = 'Service received in full.';
  repo.saveDistributor(d);
  assert.strictEqual(repo.getDistributor().ack_text, 'Service received in full.');
});

test('migration adds ack_text to an existing v1 database', function () {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const { migrations } = require('../src/main/migrations');
  migrations[0].up(db);
  db.prepare('INSERT INTO schema_version VALUES (1, ?)').run('x');
  db.prepare(`INSERT INTO distributor (id, trade_name, address, gstin, state_code, series_prefix, setup_complete)
    VALUES (1, 'Old Agency', 'Ujjain', '23ABCDE1234F1Z8', '23', 'BG', 1)`).run();

  migrate(db);

  const row = db.prepare('SELECT * FROM distributor WHERE id = 1').get();
  assert.strictEqual(row.trade_name, 'Old Agency');
  assert.ok(row.ack_text, 'existing row did not get the default acknowledgement');
});

console.log('\nDiscount and dates');

test('stores the discount on the invoice and its share on each line', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03', discount: 50 }));
  assert.strictEqual(inv.discount, 50);
  const shares = inv.lines.reduce(function (a, l) { return a + l.discount; }, 0);
  assert.strictEqual(Math.round(shares * 100) / 100, 50);
  const taxable = inv.lines.reduce(function (a, l) { return a + l.line_total; }, 0);
  assert.strictEqual(Math.round(taxable * 100) / 100, inv.taxable_value);
});

test('an invoice without a discount stores zero', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  assert.strictEqual(inv.discount, 0);
  inv.lines.forEach(function (l) { assert.strictEqual(l.discount, 0); });
});

test('dates the invoice by the local calendar, even just after midnight', function () {
  const { repo } = freshRepo();
  // 00:30 local. East of UTC, toISOString() would say the day before.
  const local = new Date(2026, 8, 15, 0, 30);
  const inv = repo.saveInvoice(customer({ invoice_date: local.toISOString() }));
  assert.strictEqual(inv.invoice_date, '2026-09-15');
});

console.log('\nDelete and edit');

test('deleting the latest invoice frees its number for the next one', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  const second = repo.saveInvoice(customer({ invoice_date: '2026-09-04' }));
  assert.strictEqual(second.invoice_no, 'SH/2627/09/0002');
  repo.deleteInvoice(second.id);
  assert.strictEqual(repo.getInvoice(second.id), null);
  const again = repo.saveInvoice(customer({ invoice_date: '2026-09-05' }));
  assert.strictEqual(again.invoice_no, 'SH/2627/09/0002');
});

test('deleting from the middle leaves later numbers alone and keeps the gap', function () {
  const { repo } = freshRepo();
  const first = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  repo.deleteInvoice(first.id);
  const next = repo.saveInvoice(customer({ invoice_date: '2026-09-06' }));
  assert.strictEqual(next.invoice_no, 'SH/2627/09/0004');
  const numbers = repo.listInvoices({}).map(function (r) { return r.invoice_no; }).sort();
  assert.deepStrictEqual(numbers, ['SH/2627/09/0002', 'SH/2627/09/0003', 'SH/2627/09/0004']);
});

test('deleting every test invoice restarts the month at 0001', function () {
  const { repo } = freshRepo();
  const ids = [1, 2, 3].map(function () { return repo.saveInvoice(customer({ invoice_date: '2026-09-03' })).id; });
  ids.forEach(function (id) { repo.deleteInvoice(id); });
  assert.strictEqual(repo.listInvoices({}).length, 0);
  assert.strictEqual(repo.saveInvoice(customer({ invoice_date: '2026-09-09' })).invoice_no, 'SH/2627/09/0001');
});

test('deleting only touches the counter of its own month', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  const oct = repo.saveInvoice(customer({ invoice_date: '2026-10-03' }));
  repo.deleteInvoice(oct.id);
  assert.strictEqual(repo.saveInvoice(customer({ invoice_date: '2026-09-20' })).invoice_no, 'SH/2627/09/0002');
  assert.strictEqual(repo.saveInvoice(customer({ invoice_date: '2026-10-20' })).invoice_no, 'SH/2627/10/0001');
});

test('editing the latest invoice keeps its number and date', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-04' }));
  const fixed = repo.replaceInvoice(inv.id, customer({ customer_name: 'Corrected Name', discount: 10 }));
  assert.strictEqual(fixed.invoice_no, inv.invoice_no);
  assert.strictEqual(fixed.invoice_date, '2026-09-04');
  assert.strictEqual(fixed.customer_name, 'Corrected Name');
  assert.strictEqual(fixed.discount, 10);
  // SQLite may hand the replacement the freed rowid; what matters is that
  // exactly one invoice carries this number and it is the corrected one.
  const all = repo.listInvoices({ q: inv.invoice_no });
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].customer_name, 'Corrected Name');
  assert.strictEqual(repo.listInvoices({}).length, 2);
});

test('editing an older invoice takes the next free number, never a used one', function () {
  const { repo } = freshRepo();
  const first = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  repo.saveInvoice(customer({ invoice_date: '2026-09-04' }));
  const fixed = repo.replaceInvoice(first.id, customer({ customer_name: 'Fixed' }));
  assert.strictEqual(fixed.invoice_no, 'SH/2627/09/0003');
  assert.strictEqual(fixed.invoice_date, '2026-09-03');
});

test('edit is one transaction — a bad payload leaves the original untouched', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  assert.throws(function () { repo.replaceInvoice(inv.id, customer({ customer_name: null })); });
  assert.ok(repo.getInvoice(inv.id), 'original was lost');
  assert.strictEqual(repo.listInvoices({}).length, 1);
});

test('listInvoices filters by date and searches number, name and consumer', function () {
  const { repo } = freshRepo();
  repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  repo.saveInvoice(customer({ invoice_date: '2026-10-03', customer_name: 'Sunita Verma', consumer_no: '9900' }));
  assert.strictEqual(repo.listInvoices({ from: '2026-09-01', to: '2026-09-30' }).length, 1);
  assert.strictEqual(repo.listInvoices({ q: 'sunita' }).length, 1);
  assert.strictEqual(repo.listInvoices({ q: '9900' }).length, 1);
  assert.strictEqual(repo.listInvoices({ q: '/10/' }).length, 1);
  assert.strictEqual(repo.listInvoices({}).length, 2);
});

console.log('\nCodes, inclusive flag and deposits on file');

test('charges carry HSN/SAC and the inclusive flag; deposits are forced to 0%', function () {
  const { repo } = freshRepo();
  const hose = repo.addCharge({ description: 'Suraksha hose', base_amount: 190, gst_rate: 18,
    effective_from: '2026-04-01', kind: 'product', hsn_sac: '4009', price_includes_gst: 1 });
  assert.strictEqual(hose.hsn_sac, '4009');
  assert.strictEqual(hose.price_includes_gst, 1);
  const dep = repo.addCharge({ description: 'Cylinder deposit', base_amount: 2200, gst_rate: 18,
    effective_from: '2026-04-01', kind: 'deposit', price_includes_gst: 1 });
  assert.strictEqual(dep.gst_rate, 0);
  assert.strictEqual(dep.price_includes_gst, 0);
  const revised = repo.reviseCharge(hose.id, { base_amount: 200, effective_from: '2026-05-01' });
  assert.strictEqual(revised.hsn_sac, '4009', 'revision dropped the code');
  assert.strictEqual(revised.price_includes_gst, 1, 'revision dropped the inclusive flag');
});

test('seeded charges carry SAC codes', function () {
  const { repo } = freshRepo();
  const { seedCharges } = require('../src/main/seed');
  seedCharges(repo);
  const dgcc = repo.activeCharges().find(function (c) { return /DGCC/.test(c.description); });
  assert.strictEqual(dgcc.hsn_sac, '998599');
});

test('an invoice stores codes, pricing basis and deposits, and reports leave deposits out', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03', lines: [
    { description: 'DGCC', qty: 1, rate: 59, gstRate: 18, inclusive: true, hsnSac: '998599' },
    { description: 'Deposit', qty: 1, rate: 258.58, nonGst: true }
  ] }));
  assert.strictEqual(inv.taxable_value, 50);
  assert.strictEqual(inv.non_gst_value, 258.58);
  assert.strictEqual(inv.total, 318);
  const dgcc = inv.lines.find(function (l) { return l.description === 'DGCC'; });
  assert.strictEqual(dgcc.hsn_sac, '998599');
  assert.strictEqual(dgcc.inclusive, 1);
  const dep = inv.lines.find(function (l) { return l.description === 'Deposit'; });
  assert.strictEqual(dep.non_gst, 1);
  assert.strictEqual(dep.line_total, 258.58);

  const reports = require('../src/main/reports');
  const b2cs = reports.b2csSummary([inv]);
  const taxable = b2cs.reduce(function (a, r) { return a + Number(r['Taxable value']); }, 0);
  assert.strictEqual(taxable, 50);
  assert.ok(!b2cs.some(function (r) { return Number(r['Rate (%)']) === 0; }), 'deposit leaked into B2CS as 0%');
});

test('distributor wording round-trips', function () {
  const { repo } = freshRepo();
  const d = repo.getDistributor();
  repo.saveDistributor(Object.assign({}, d, { tagline: 'Authorised Distributor for Bharat Gas', jurisdiction: 'Subject to Ujjain jurisdiction' }));
  assert.strictEqual(repo.getDistributor().jurisdiction, 'Subject to Ujjain jurisdiction');
});

console.log('\nPlace of supply follows the distributor');

test('an invoice for a Gujarat distributor says Gujarat, not Madhya Pradesh', function () {
  const { repo } = freshRepo();
  const d = repo.getDistributor();
  repo.saveDistributor(Object.assign({}, d, { gstin: '24ABQPZ7781K1ZJ', state_code: '24' }));
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03', place_of_supply: null, place_of_supply_code: '24' }));
  assert.strictEqual(inv.place_of_supply, 'Gujarat');
  assert.strictEqual(inv.place_of_supply_code, '24');
  assert.strictEqual(inv.igst, 0, 'intra-state must split CGST/SGST');
});

console.log('\nCustomer mobile');

test('the mobile is copied onto the invoice, like every other particular', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03', customer_mobile: '9876543210' }));
  assert.strictEqual(inv.customer_mobile, '9876543210');
  assert.strictEqual(repo.listInvoices({})[0].customer_mobile, '9876543210');
  const reports = require('../src/main/reports');
  assert.strictEqual(reports.invoiceRegister([inv])[0]['Mobile'], '9876543210');
});

test('an invoice without a mobile stores null, and the register shows blank', function () {
  const { repo } = freshRepo();
  const inv = repo.saveInvoice(customer({ invoice_date: '2026-09-03' }));
  assert.strictEqual(inv.customer_mobile, null);
  const reports = require('../src/main/reports');
  assert.strictEqual(reports.invoiceRegister([inv])[0]['Mobile'], '');
});

console.log('\n' + passed + ' passed\n');
