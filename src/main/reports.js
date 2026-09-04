'use strict';

const gst = require('../shared/gst');

function money(n) { return Number(Number(n).toFixed(2)); }

function invoiceRegister(invoices) {
  return invoices.map(function (inv) {
    return {
      'Invoice no': inv.invoice_no,
      'Date': inv.invoice_date,
      'Consumer no': inv.consumer_no || '',
      'Customer name': inv.customer_name,
      'Customer GSTIN': inv.customer_gstin || '',
      'Type': inv.customer_gstin ? 'B2B' : 'B2C',
      'Place of supply': inv.place_of_supply + ' (' + inv.place_of_supply_code + ')',
      'Taxable value': money(inv.taxable_value),
      'CGST': money(inv.cgst),
      'SGST': money(inv.sgst),
      'IGST': money(inv.igst),
      'Rounding': money(inv.rounding),
      'Total': money(inv.total)
    };
  });
}

function b2csSummary(invoices) {
  const buckets = new Map();

  for (const inv of invoices) {
    if (inv.customer_gstin) continue;
    for (const line of inv.lines) {
      const key = inv.place_of_supply_code + '|' + line.gst_rate;
      if (!buckets.has(key)) {
        buckets.set(key, {
          'Place of supply': inv.place_of_supply + ' (' + inv.place_of_supply_code + ')',
          'Rate (%)': line.gst_rate,
          'Taxable value': 0,
          'CGST': 0,
          'SGST': 0,
          'IGST': 0,
          'Invoices': new Set()
        });
      }
      const bucket = buckets.get(key);
      bucket['Taxable value'] += line.line_total;
      if (inv.igst > 0) {
        bucket['IGST'] += line.tax_amount;
      } else {
        bucket['CGST'] += line.tax_amount / 2;
        bucket['SGST'] += line.tax_amount / 2;
      }
      bucket['Invoices'].add(inv.invoice_no);
    }
  }

  return Array.from(buckets.values()).map(function (b) {
    return {
      'Place of supply': b['Place of supply'],
      'Rate (%)': b['Rate (%)'],
      'Taxable value': money(b['Taxable value']),
      'CGST': money(b['CGST']),
      'SGST': money(b['SGST']),
      'IGST': money(b['IGST']),
      'Invoice count': b['Invoices'].size
    };
  }).sort(function (a, b) { return a['Rate (%)'] - b['Rate (%)']; });
}

function b2bDetail(invoices) {
  const rows = [];
  for (const inv of invoices) {
    if (!inv.customer_gstin) continue;
    for (const line of inv.lines) {
      rows.push({
        'Recipient GSTIN': inv.customer_gstin,
        'Recipient name': inv.customer_name,
        'Invoice no': inv.invoice_no,
        'Date': inv.invoice_date,
        'Invoice value': money(inv.total),
        'Place of supply': inv.place_of_supply + ' (' + inv.place_of_supply_code + ')',
        'Rate (%)': line.gst_rate,
        'Taxable value': money(line.line_total),
        'Tax': money(line.tax_amount)
      });
    }
  }
  return rows;
}

function chargeSummary(invoices) {
  const buckets = new Map();

  for (const inv of invoices) {
    for (const line of inv.lines) {
      const key = line.description + '|' + line.gst_rate;
      if (!buckets.has(key)) {
        buckets.set(key, {
          'Description': line.description,
          'Rate (%)': line.gst_rate,
          'Quantity': 0,
          'Taxable value': 0,
          'CGST': 0,
          'SGST': 0,
          'IGST': 0
        });
      }
      const bucket = buckets.get(key);
      bucket['Quantity'] += line.qty;
      bucket['Taxable value'] += line.line_total;
      if (inv.igst > 0) {
        bucket['IGST'] += line.tax_amount;
      } else {
        bucket['CGST'] += line.tax_amount / 2;
        bucket['SGST'] += line.tax_amount / 2;
      }
    }
  }

  return Array.from(buckets.values()).map(function (b) {
    return Object.assign({}, b, {
      'Taxable value': money(b['Taxable value']),
      'CGST': money(b['CGST']),
      'SGST': money(b['SGST']),
      'IGST': money(b['IGST'])
    });
  }).sort(function (a, b) { return a['Description'].localeCompare(b['Description']); });
}

function monthlyTotals(invoices) {
  const buckets = new Map();

  for (const inv of invoices) {
    const month = inv.invoice_date.slice(0, 7);
    if (!buckets.has(month)) {
      buckets.set(month, {
        'Month': month, 'Invoices': 0, 'Taxable value': 0,
        'CGST': 0, 'SGST': 0, 'IGST': 0, 'Rounding': 0, 'Total': 0
      });
    }
    const b = buckets.get(month);
    b['Invoices'] += 1;
    b['Taxable value'] += inv.taxable_value;
    b['CGST'] += inv.cgst;
    b['SGST'] += inv.sgst;
    b['IGST'] += inv.igst;
    b['Rounding'] += inv.rounding;
    b['Total'] += inv.total;
  }

  return Array.from(buckets.values())
    .map(function (b) {
      return Object.assign({}, b, {
        'Taxable value': money(b['Taxable value']),
        'CGST': money(b['CGST']),
        'SGST': money(b['SGST']),
        'IGST': money(b['IGST']),
        'Rounding': money(b['Rounding']),
        'Total': money(b['Total'])
      });
    })
    .sort(function (a, b) { return a.Month.localeCompare(b.Month); });
}

function creditNoteRegister(notes) {
  return notes.map(function (n) {
    return {
      'Note no': n.note_no,
      'Date': n.note_date,
      'Against invoice': n.invoice_no,
      'Reason': n.reason,
      'Taxable value': money(n.taxable_value),
      'CGST': money(n.cgst),
      'SGST': money(n.sgst),
      'IGST': money(n.igst),
      'Total': money(n.total)
    };
  });
}

function buildWorkbook(XLSX, data) {
  const wb = XLSX.utils.book_new();
  const sheets = [
    ['Invoice register', invoiceRegister(data.invoices)],
    ['B2CS summary', b2csSummary(data.invoices)],
    ['B2B detail', b2bDetail(data.invoices)],
    ['Charge summary', chargeSummary(data.invoices)],
    ['Credit notes', creditNoteRegister(data.creditNotes || [])],
    ['Monthly totals', monthlyTotals(data.invoices)]
  ];

  for (const pair of sheets) {
    const rows = pair[1].length ? pair[1] : [{ 'No records in this period': '' }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), pair[0]);
  }
  return wb;
}

function periodForFinancialYear(date) {
  const fy = gst.financialYear(date);
  const iso = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  return { from: iso(fy.startsOn), to: iso(fy.endsOn), label: fy.label };
}

module.exports = {
  invoiceRegister, b2csSummary, b2bDetail, chargeSummary,
  monthlyTotals, creditNoteRegister, buildWorkbook, periodForFinancialYear
};
