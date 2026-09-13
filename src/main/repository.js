'use strict';

const gst = require('../shared/gst');

const DEFAULT_ACK = 'I confirm the service described above was carried out at my premises ' +
  'to my satisfaction, and that I have received the original of this invoice.';

function withDefaults(d) {
  return Object.assign({ ack_text: DEFAULT_ACK, tagline: null, jurisdiction: null }, d,
    d.ack_text ? {} : { ack_text: DEFAULT_ACK });
}

/* A deposit carries no GST whatever was typed, and a price cannot "include"
   tax it does not carry. */
function normaliseCharge(c) {
  const out = Object.assign({}, c);
  out.hsn_sac = (out.hsn_sac || '').trim() || null;
  out.price_includes_gst = out.price_includes_gst ? 1 : 0;
  if (out.kind === 'deposit') {
    out.gst_rate = 0;
    out.price_includes_gst = 0;
  }
  return out;
}

/* An HSN/SAC code is a classification, not a price, so a line saved before
   the item had one can borrow the item's current code for printing. Lines
   that carry their own keep it. */
const LINES_SQL = `SELECT l.*,
    COALESCE(l.hsn_sac, (SELECT c.hsn_sac FROM charges c
      WHERE c.description = l.description AND c.is_active = 1 LIMIT 1)) AS hsn_sac
  FROM invoice_lines l WHERE l.invoice_id = ?`;

function createRepository(db) {
  function getDistributor() {
    return db.prepare('SELECT * FROM distributor WHERE id = 1').get() || null;
  }

  function saveDistributor(d) {
    const existing = getDistributor();
    if (existing) {
      db.prepare(`UPDATE distributor SET trade_name=@trade_name, legal_name=@legal_name,
        address=@address, gstin=@gstin, state_code=@state_code, phone=@phone,
        logo_path=@logo_path, certificate_path=@certificate_path,
        series_prefix=@series_prefix, backup_folder=@backup_folder,
        setup_complete=@setup_complete, ack_text=@ack_text,
        tagline=@tagline, jurisdiction=@jurisdiction WHERE id=1`).run(withDefaults(d));
    } else {
      db.prepare(`INSERT INTO distributor (id, trade_name, legal_name, address, gstin,
        state_code, phone, logo_path, certificate_path, series_prefix, backup_folder,
        setup_complete, ack_text, tagline, jurisdiction)
        VALUES (1, @trade_name, @legal_name, @address, @gstin, @state_code, @phone,
        @logo_path, @certificate_path, @series_prefix, @backup_folder, @setup_complete,
        @ack_text, @tagline, @jurisdiction)`).run(withDefaults(d));
    }
    return getDistributor();
  }

  function activeCharges() {
    return db.prepare('SELECT * FROM charges WHERE is_active = 1 ORDER BY description').all();
  }

  function allCharges() {
    return db.prepare('SELECT * FROM charges ORDER BY is_active DESC, description').all();
  }

  function addCharge(c) {
    const row = normaliseCharge(Object.assign({ needs_confirmation: 0, kind: 'service' }, c));
    const info = db.prepare(`INSERT INTO charges (description, base_amount, gst_rate,
      effective_from, is_active, needs_confirmation, kind, hsn_sac, price_includes_gst)
      VALUES (@description, @base_amount, @gst_rate, @effective_from, 1, @needs_confirmation,
      @kind, @hsn_sac, @price_includes_gst)`).run(row);
    return db.prepare('SELECT * FROM charges WHERE id = ?').get(info.lastInsertRowid);
  }

  const reviseCharge = db.transaction(function (id, next) {
    const old = db.prepare('SELECT * FROM charges WHERE id = ?').get(id);
    if (!old) throw new Error('No charge with id ' + id);

    db.prepare('UPDATE charges SET is_active = 0, superseded_on = ? WHERE id = ?')
      .run(next.effective_from, id);

    const row = normaliseCharge({
      description: next.description || old.description,
      base_amount: next.base_amount,
      gst_rate: next.gst_rate == null ? old.gst_rate : next.gst_rate,
      effective_from: next.effective_from,
      kind: next.kind || old.kind || 'service',
      hsn_sac: next.hsn_sac === undefined ? old.hsn_sac : next.hsn_sac,
      price_includes_gst: next.price_includes_gst === undefined ? old.price_includes_gst : next.price_includes_gst
    });
    const info = db.prepare(`INSERT INTO charges (description, base_amount, gst_rate,
      effective_from, is_active, needs_confirmation, replaces_id, kind, hsn_sac, price_includes_gst)
      VALUES (@description, @base_amount, @gst_rate, @effective_from, 1, 0, @replaces_id, @kind,
      @hsn_sac, @price_includes_gst)`).run(Object.assign(row, { replaces_id: id }));

    return db.prepare('SELECT * FROM charges WHERE id = ?').get(info.lastInsertRowid);
  });

  function chargeUsageCount(id) {
    return db.prepare(`SELECT COUNT(*) AS n FROM invoice_lines l
      JOIN charges c ON c.description = l.description AND c.id = ?`).get(id).n;
  }

  function findConsumer(consumerNo) {
    return db.prepare('SELECT * FROM consumers WHERE consumer_no = ?').get(String(consumerNo).trim()) || null;
  }

  function searchConsumers(query, limit) {
    const q = String(query || '').trim();
    if (!q) return [];
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    return db.prepare(`SELECT * FROM consumers
      WHERE consumer_no LIKE ? OR name LIKE ?
      ORDER BY CASE WHEN consumer_no LIKE ? THEN 0 ELSE 1 END, name
      LIMIT ?`).all(like, like, q + '%', limit || 6);
  }

  const importConsumers = db.transaction(function (rows) {
    const stmt = db.prepare(`INSERT INTO consumers (consumer_no, name, address, mobile, updated_at)
      VALUES (@consumer_no, @name, @address, @mobile, @updated_at)
      ON CONFLICT(consumer_no) DO UPDATE SET
        name=excluded.name, address=excluded.address,
        mobile=excluded.mobile, updated_at=excluded.updated_at`);

    const now = new Date().toISOString();
    let created = 0, updated = 0, skipped = 0;

    for (const row of rows) {
      const no = String(row.consumer_no || '').trim();
      if (!no || !row.name) { skipped++; continue; }
      const exists = db.prepare('SELECT 1 FROM consumers WHERE consumer_no = ?').get(no);
      stmt.run({
        consumer_no: no,
        name: String(row.name).trim(),
        address: row.address ? String(row.address).trim() : null,
        mobile: row.mobile ? String(row.mobile).trim() : null,
        updated_at: now
      });
      if (exists) updated++; else created++;
    }
    return { created, updated, skipped };
  });

  function nextInvoicePreview(date) {
    const d = getDistributor();
    const when = date || new Date();
    const row = db.prepare('SELECT next_value FROM invoice_counters WHERE period_key = ?')
      .get(gst.periodKey(when));
    return gst.buildInvoiceNumber(d.series_prefix, when, row ? row.next_value : 1);
  }

  function insertInvoice(payload) {
    const d = getDistributor();
    if (!d) throw new Error('Distributor setup is not complete.');

    const date = payload.invoice_date ? new Date(payload.invoice_date) : new Date();
    const fy = gst.financialYear(date);
    const period = gst.periodKey(date);

    db.prepare('INSERT INTO invoice_counters (period_key, next_value) VALUES (?, 1) ON CONFLICT(period_key) DO NOTHING')
      .run(period);
    const counter = db.prepare('SELECT next_value FROM invoice_counters WHERE period_key = ?').get(period).next_value;
    const invoiceNo = gst.buildInvoiceNumber(d.series_prefix, date, counter);
    db.prepare('UPDATE invoice_counters SET next_value = next_value + 1 WHERE period_key = ?').run(period);

    const posCode = payload.place_of_supply_code || d.state_code;
    const computed = gst.computeInvoice(payload.lines, d.state_code, posCode, payload.discount);

    const info = db.prepare(`INSERT INTO invoices (invoice_no, fy_label, invoice_date, consumer_no,
      customer_name, customer_address, customer_gstin, place_of_supply, place_of_supply_code,
      reverse_charge, discount, taxable_value, cgst, sgst, igst, non_gst_value, rounding, total,
      amount_in_words, status, created_at)
      VALUES (@invoice_no, @fy_label, @invoice_date, @consumer_no, @customer_name, @customer_address,
      @customer_gstin, @place_of_supply, @place_of_supply_code, 0, @discount, @taxable_value, @cgst, @sgst,
      @igst, @non_gst_value, @rounding, @total, @amount_in_words, 'issued', @created_at)`).run({
      invoice_no: invoiceNo,
      fy_label: fy.label,
      invoice_date: gst.localDate(date),
      consumer_no: payload.consumer_no || null,
      customer_name: payload.customer_name,
      customer_address: payload.customer_address || null,
      customer_gstin: payload.customer_gstin || null,
      place_of_supply: payload.place_of_supply || 'Madhya Pradesh',
      place_of_supply_code: posCode,
      discount: computed.discount,
      taxable_value: computed.taxable,
      cgst: computed.cgst,
      sgst: computed.sgst,
      igst: computed.igst,
      non_gst_value: computed.nonGst,
      rounding: computed.rounding,
      total: computed.total,
      amount_in_words: gst.amountInWords(computed.total),
      created_at: new Date().toISOString()
    });

    const lineStmt = db.prepare(`INSERT INTO invoice_lines (invoice_id, description,
      qty, rate, gst_rate, discount, line_total, tax_amount, hsn_sac, inclusive, non_gst)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const line of computed.lines) {
      lineStmt.run(info.lastInsertRowid, line.description,
        line.qty, line.rate, line.gstRate, line.discount, line.lineTotal, line.taxAmount,
        line.hsnSac || null, line.inclusive ? 1 : 0, line.nonGst ? 1 : 0);
    }

    return getInvoice(info.lastInsertRowid);
  }

  const saveInvoice = db.transaction(insertInvoice);

  /* The counter for a month is "one past the highest number still on file",
     recomputed from the invoices themselves. So deleting the latest invoice
     hands its number to the next one, and deleting every test invoice before
     go-live restarts the series at 0001 without a reset button. Deleting one
     from the middle leaves the later numbers as they are — they are on
     printed paper — and the gap stays. */
  function recomputeCounter(periodKey) {
    const fy = periodKey.slice(0, 4);
    const month = periodKey.slice(5, 7);
    const row = db.prepare(`SELECT MAX(CAST(substr(invoice_no, -4) AS INTEGER)) AS top
      FROM invoices WHERE fy_label = ? AND substr(invoice_date, 6, 2) = ?`).get(fy, month);
    const next = (row && row.top ? row.top : 0) + 1;
    db.prepare(`INSERT INTO invoice_counters (period_key, next_value) VALUES (?, ?)
      ON CONFLICT(period_key) DO UPDATE SET next_value = excluded.next_value`).run(periodKey, next);
    return next;
  }

  function removeInvoiceRows(id) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new Error('That invoice no longer exists.');
    const notes = db.prepare('SELECT COUNT(*) AS n FROM credit_notes WHERE invoice_id = ?').get(id).n;
    if (notes) throw new Error('A credit note refers to ' + inv.invoice_no + '; it cannot be deleted.');
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    recomputeCounter(gst.periodKey(inv.invoice_date));
    return inv;
  }

  const deleteInvoice = db.transaction(function (id) {
    const inv = removeInvoiceRows(id);
    return { invoice_no: inv.invoice_no };
  });

  /* Edit = delete the old row and insert the corrected one in a single
     transaction. The date is kept unless the caller sends one; the number is
     the same one if the old invoice was the latest of its month, otherwise
     the next free number. */
  const replaceInvoice = db.transaction(function (id, payload) {
    const old = removeInvoiceRows(id);
    const next = Object.assign({}, payload, {
      invoice_date: payload.invoice_date || old.invoice_date
    });
    return insertInvoice(next);
  });

  function listInvoices(filter) {
    const f = filter || {};
    const where = [];
    const args = [];
    if (f.from) { where.push('invoice_date >= ?'); args.push(f.from); }
    if (f.to) { where.push('invoice_date <= ?'); args.push(f.to); }
    if (f.q) {
      where.push('(invoice_no LIKE ? OR customer_name LIKE ? OR consumer_no LIKE ?)');
      const like = '%' + f.q + '%';
      args.push(like, like, like);
    }
    return db.prepare(`SELECT id, invoice_no, invoice_date, consumer_no, customer_name, total, discount
      FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY invoice_date DESC, id DESC LIMIT 500`).all(...args);
  }

  function getInvoice(id) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) return null;
    inv.lines = db.prepare(LINES_SQL).all(id);
    return inv;
  }

  function listBundles() {
    const rows = db.prepare('SELECT * FROM bundles WHERE is_active = 1 ORDER BY name').all();
    for (const b of rows) {
      b.items = db.prepare('SELECT description, qty FROM bundle_items WHERE bundle_id = ? ORDER BY id')
        .all(b.id);
    }
    return rows;
  }

  const saveBundle = db.transaction(function (bundle) {
    let id = bundle.id;
    if (id) {
      db.prepare('UPDATE bundles SET name = ? WHERE id = ?').run(bundle.name, id);
      db.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').run(id);
    } else {
      id = db.prepare('INSERT INTO bundles (name, is_active, created_at) VALUES (?, 1, ?)')
        .run(bundle.name, new Date().toISOString()).lastInsertRowid;
    }

    const stmt = db.prepare('INSERT INTO bundle_items (bundle_id, description, qty) VALUES (?, ?, ?)');
    for (const item of bundle.items || []) {
      stmt.run(id, item.description, Number(item.qty) || 1);
    }
    return db.prepare('SELECT * FROM bundles WHERE id = ?').get(id);
  });

  function deleteBundle(id) {
    db.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').run(id);
    db.prepare('DELETE FROM bundles WHERE id = ?').run(id);
    return { deleted: id };
  }

  /* Items are stored by description because a charge gets a brand new row and
     id every time its rate is revised, so an id would go stale immediately.
     Anything that no longer matches an active charge is handed back as
     `missing` rather than dropped on the floor. */
  function resolveBundle(id) {
    const items = db.prepare('SELECT description, qty FROM bundle_items WHERE bundle_id = ? ORDER BY id')
      .all(id);
    const resolved = [];
    const missing = [];
    for (const item of items) {
      const charge = db.prepare('SELECT * FROM charges WHERE is_active = 1 AND description = ?')
        .get(item.description);
      if (charge) resolved.push({ charge: charge, qty: item.qty });
      else missing.push(item.description);
    }
    return { resolved: resolved, missing: missing };
  }

  function invoicesBetween(fromDate, toDate) {
    const rows = db.prepare(`SELECT * FROM invoices WHERE invoice_date BETWEEN ? AND ?
      ORDER BY invoice_date, id`).all(fromDate, toDate);
    for (const r of rows) {
      r.lines = db.prepare(LINES_SQL).all(r.id);
    }
    return rows;
  }

  return {
    getDistributor, saveDistributor,
    activeCharges, allCharges, addCharge, reviseCharge, chargeUsageCount,
    listBundles, saveBundle, deleteBundle, resolveBundle,
    findConsumer, searchConsumers, importConsumers,
    nextInvoicePreview, saveInvoice, getInvoice, invoicesBetween,
    listInvoices, deleteInvoice, replaceInvoice, recomputeCounter
  };
}

module.exports = { createRepository, DEFAULT_ACK };
