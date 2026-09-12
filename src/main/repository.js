'use strict';

const gst = require('../shared/gst');

const DEFAULT_ACK = 'I confirm the service described above was carried out at my premises ' +
  'to my satisfaction, and that I have received the original of this invoice.';

function withDefaults(d) {
  return Object.assign({ ack_text: DEFAULT_ACK }, d,
    d.ack_text ? {} : { ack_text: DEFAULT_ACK });
}

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
        setup_complete=@setup_complete, ack_text=@ack_text WHERE id=1`).run(withDefaults(d));
    } else {
      db.prepare(`INSERT INTO distributor (id, trade_name, legal_name, address, gstin,
        state_code, phone, logo_path, certificate_path, series_prefix, backup_folder,
        setup_complete, ack_text)
        VALUES (1, @trade_name, @legal_name, @address, @gstin, @state_code, @phone,
        @logo_path, @certificate_path, @series_prefix, @backup_folder, @setup_complete,
        @ack_text)`).run(withDefaults(d));
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
    const info = db.prepare(`INSERT INTO charges (description, base_amount, gst_rate,
      effective_from, is_active, needs_confirmation, kind)
      VALUES (@description, @base_amount, @gst_rate, @effective_from, 1, @needs_confirmation, @kind)`)
      .run(Object.assign({ needs_confirmation: 0, kind: 'service' }, c));
    return db.prepare('SELECT * FROM charges WHERE id = ?').get(info.lastInsertRowid);
  }

  const reviseCharge = db.transaction(function (id, next) {
    const old = db.prepare('SELECT * FROM charges WHERE id = ?').get(id);
    if (!old) throw new Error('No charge with id ' + id);

    db.prepare('UPDATE charges SET is_active = 0, superseded_on = ? WHERE id = ?')
      .run(next.effective_from, id);

    const info = db.prepare(`INSERT INTO charges (description, base_amount, gst_rate,
      effective_from, is_active, needs_confirmation, replaces_id, kind)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?)`)
      .run(next.description || old.description,
           next.base_amount,
           next.gst_rate == null ? old.gst_rate : next.gst_rate,
           next.effective_from,
           id,
           next.kind || old.kind || 'service');

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

  const saveInvoice = db.transaction(function (payload) {
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
      reverse_charge, discount, taxable_value, cgst, sgst, igst, rounding, total, amount_in_words, status, created_at)
      VALUES (@invoice_no, @fy_label, @invoice_date, @consumer_no, @customer_name, @customer_address,
      @customer_gstin, @place_of_supply, @place_of_supply_code, 0, @discount, @taxable_value, @cgst, @sgst,
      @igst, @rounding, @total, @amount_in_words, 'issued', @created_at)`).run({
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
      rounding: computed.rounding,
      total: computed.total,
      amount_in_words: gst.amountInWords(computed.total),
      created_at: new Date().toISOString()
    });

    const lineStmt = db.prepare(`INSERT INTO invoice_lines (invoice_id, description,
      qty, rate, gst_rate, discount, line_total, tax_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const line of computed.lines) {
      lineStmt.run(info.lastInsertRowid, line.description,
        line.qty, line.rate, line.gstRate, line.discount, line.lineTotal, line.taxAmount);
    }

    return getInvoice(info.lastInsertRowid);
  });

  function getInvoice(id) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) return null;
    inv.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(id);
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
      r.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(r.id);
    }
    return rows;
  }

  return {
    getDistributor, saveDistributor,
    activeCharges, allCharges, addCharge, reviseCharge, chargeUsageCount,
    listBundles, saveBundle, deleteBundle, resolveBundle,
    findConsumer, searchConsumers, importConsumers,
    nextInvoicePreview, saveInvoice, getInvoice, invoicesBetween
  };
}

module.exports = { createRepository, DEFAULT_ACK };
