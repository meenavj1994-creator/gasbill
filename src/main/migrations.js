'use strict';

const migrations = [
  {
    version: 1,
    name: 'initial schema',
    up: function (db) {
      db.exec(`
        CREATE TABLE distributor (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          trade_name TEXT NOT NULL,
          legal_name TEXT,
          address TEXT NOT NULL,
          gstin TEXT NOT NULL,
          state_code TEXT NOT NULL DEFAULT '23',
          phone TEXT,
          logo_path TEXT,
          certificate_path TEXT,
          series_prefix TEXT NOT NULL DEFAULT 'BG',
          backup_folder TEXT,
          setup_complete INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE invoice_counters (
          fy_label TEXT PRIMARY KEY,
          next_value INTEGER NOT NULL
        );

        CREATE TABLE charges (
          id INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          sac_code TEXT,
          base_amount REAL NOT NULL,
          gst_rate REAL NOT NULL DEFAULT 18,
          effective_from TEXT NOT NULL,
          superseded_on TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          needs_confirmation INTEGER NOT NULL DEFAULT 0,
          replaces_id INTEGER REFERENCES charges(id)
        );

        CREATE TABLE consumers (
          consumer_no TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          address TEXT,
          mobile TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE invoices (
          id INTEGER PRIMARY KEY,
          invoice_no TEXT NOT NULL UNIQUE,
          fy_label TEXT NOT NULL,
          invoice_date TEXT NOT NULL,
          consumer_no TEXT,
          customer_name TEXT NOT NULL,
          customer_address TEXT,
          customer_gstin TEXT,
          place_of_supply TEXT NOT NULL,
          place_of_supply_code TEXT NOT NULL,
          reverse_charge INTEGER NOT NULL DEFAULT 0,
          taxable_value REAL NOT NULL,
          cgst REAL NOT NULL DEFAULT 0,
          sgst REAL NOT NULL DEFAULT 0,
          igst REAL NOT NULL DEFAULT 0,
          rounding REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL,
          amount_in_words TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'issued',
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_invoices_date ON invoices (invoice_date);
        CREATE INDEX idx_invoices_fy ON invoices (fy_label);

        CREATE TABLE invoice_lines (
          id INTEGER PRIMARY KEY,
          invoice_id INTEGER NOT NULL REFERENCES invoices(id),
          description TEXT NOT NULL,
          sac_code TEXT,
          qty REAL NOT NULL DEFAULT 1,
          rate REAL NOT NULL,
          gst_rate REAL NOT NULL,
          line_total REAL NOT NULL,
          tax_amount REAL NOT NULL
        );

        CREATE INDEX idx_lines_invoice ON invoice_lines (invoice_id);

        CREATE TABLE credit_notes (
          id INTEGER PRIMARY KEY,
          note_no TEXT NOT NULL UNIQUE,
          fy_label TEXT NOT NULL,
          note_date TEXT NOT NULL,
          invoice_id INTEGER NOT NULL REFERENCES invoices(id),
          reason TEXT NOT NULL,
          taxable_value REAL NOT NULL,
          cgst REAL NOT NULL DEFAULT 0,
          sgst REAL NOT NULL DEFAULT 0,
          igst REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE backups (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  }
  ,{
    version: 2,
    name: 'customer acknowledgement on duplicate copy',
    up: function (db) {
      db.exec(`ALTER TABLE distributor ADD COLUMN ack_text TEXT`);
      db.prepare('UPDATE distributor SET ack_text = ? WHERE ack_text IS NULL').run(
        'I confirm the service described above was carried out at my premises to my ' +
        'satisfaction, and that I have received the original of this invoice.'
      );
    }
  }
  ,{
    version: 3,
    name: 'drop SAC code',
    up: function (db) {
      db.exec(`ALTER TABLE charges DROP COLUMN sac_code`);
      db.exec(`ALTER TABLE invoice_lines DROP COLUMN sac_code`);
    }
  }
  ,{
    version: 4,
    name: 'monthly invoice counters',
    up: function (db) {
      // The counter is now owned by a financial year *and* month ("2627-09"),
      // so the column no longer holds what its old name claimed.
      db.exec(`ALTER TABLE invoice_counters RENAME COLUMN fy_label TO period_key`);
    }
  }
  ,{
    version: 5,
    name: 'product items and predefined sets',
    up: function (db) {
      // Hot plates and hoses bill exactly like a service line — description,
      // amount, GST rate, quantity — so they live in the same table. `kind`
      // only decides which group they appear under.
      db.exec(`ALTER TABLE charges ADD COLUMN kind TEXT NOT NULL DEFAULT 'service'`);

      db.exec(`
        CREATE TABLE bundles (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );

        CREATE TABLE bundle_items (
          id INTEGER PRIMARY KEY,
          bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
          description TEXT NOT NULL,
          qty REAL NOT NULL DEFAULT 1
        );

        CREATE INDEX idx_bundle_items_bundle ON bundle_items (bundle_id);
      `);
    }
  },
  {
    version: 6,
    name: 'invoice discount',
    up: function (db) {
      // line_total keeps meaning "taxable value of the line", so every report
      // that reads it stays right. The discount is stored alongside: on the
      // invoice as the figure the operator typed, on each line as its share,
      // so gross (line_total + discount) can always be rebuilt for the print.
      db.exec('ALTER TABLE invoices ADD COLUMN discount REAL NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE invoice_lines ADD COLUMN discount REAL NOT NULL DEFAULT 0');
    }
  },
  {
    version: 7,
    name: 'HSN/SAC, inclusive pricing, deposits, invoice wording',
    up: function (db) {
      // Items: a code column, and a flag for prices quoted with GST inside
      // them (the circular's "amount incl. GST" figure, or a product MRP).
      db.exec("ALTER TABLE charges ADD COLUMN hsn_sac TEXT");
      db.exec("ALTER TABLE charges ADD COLUMN price_includes_gst INTEGER NOT NULL DEFAULT 0");

      // Lines copy the code and remember how they were priced. non_gst marks
      // a refundable deposit: on the invoice and in the total, outside GST.
      db.exec("ALTER TABLE invoice_lines ADD COLUMN hsn_sac TEXT");
      db.exec("ALTER TABLE invoice_lines ADD COLUMN inclusive INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE invoice_lines ADD COLUMN non_gst INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE invoices ADD COLUMN non_gst_value REAL NOT NULL DEFAULT 0");

      db.exec("ALTER TABLE distributor ADD COLUMN tagline TEXT");
      db.exec("ALTER TABLE distributor ADD COLUMN jurisdiction TEXT");
      db.exec("UPDATE distributor SET tagline = 'Authorised Distributor for Bharat Gas' WHERE tagline IS NULL");

      // Seeded charges on existing installs get the same SAC codes a fresh
      // install would. Anything the distributor typed themselves is left alone.
      const codes = require('./seed').SEED;
      const set = db.prepare('UPDATE charges SET hsn_sac = ? WHERE description = ? AND hsn_sac IS NULL');
      for (const row of codes) if (row.hsn_sac) set.run(row.hsn_sac, row.description);
    }
  },
  {
    version: 8,
    name: 'customer mobile on the invoice',
    up: function (db) {
      // Copied onto the invoice like every other customer particular, so a
      // later change to the consumer record cannot alter a past invoice.
      db.exec('ALTER TABLE invoices ADD COLUMN customer_mobile TEXT');
    }
  }
];

function migrate(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');

  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
  const pending = migrations.filter(function (m) { return m.version > current; });

  for (const m of pending) {
    db.transaction(function () {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    })();
    console.log('migrated to v' + m.version + ' — ' + m.name);
  }
  return { from: current, to: current + pending.length };
}

module.exports = { migrate, migrations };
