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

console.log('\n' + passed + ' passed\n');
