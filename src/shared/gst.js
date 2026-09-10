'use strict';

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

function validateGstin(raw, expectedStateCode) {
  const gstin = String(raw || '').toUpperCase().replace(/\s/g, '');

  if (gstin.length !== 15) {
    return { valid: false, reason: 'A GSTIN is 15 characters. This one has ' + gstin.length + '.' };
  }
  if (!GSTIN_SHAPE.test(gstin)) {
    return { valid: false, reason: 'The characters are not in the expected GSTIN pattern.' };
  }
  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, reason: 'The check digit does not match. Some character was read or typed wrongly.' };
  }
  if (expectedStateCode && gstin.slice(0, 2) !== expectedStateCode) {
    return {
      valid: false,
      reason: 'State code reads ' + gstin.slice(0, 2) + ', expected ' + expectedStateCode + '.',
      stateMismatch: true
    };
  }
  return { valid: true, gstin, stateCode: gstin.slice(0, 2), pan: gstin.slice(2, 12) };
}

function financialYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? year : year - 1;
  return {
    startYear,
    endYear: startYear + 1,
    label: String(startYear % 100).padStart(2, '0') + String((startYear + 1) % 100).padStart(2, '0'),
    startsOn: new Date(startYear, 3, 1),
    endsOn: new Date(startYear + 1, 2, 31)
  };
}

/* Counters restart every month, so the key that owns a counter is the
   financial year plus the calendar month — not the year alone. */
function periodKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return financialYear(d).label + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function seriesPrefix(tradeName) {
  const letters = String(tradeName || '').toUpperCase().replace(/[^A-Z]/g, '');
  return letters.slice(0, 2) || 'GB';
}

function buildInvoiceNumber(prefix, date, counter) {
  const d = date instanceof Date ? date : new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const number = prefix + '/' + financialYear(d).label + '/' + month + '/' +
    String(counter).padStart(4, '0');
  if (number.length > 16) {
    throw new Error('Invoice number "' + number + '" exceeds the 16 character limit under Rule 46(b). Shorten the series prefix.');
  }
  return number;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeInvoice(lines, supplierStateCode, placeOfSupplyCode) {
  const intraState = supplierStateCode === placeOfSupplyCode;
  let taxable = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  const buckets = new Map();

  const priced = lines.map(function (line) {
    const qty = Number(line.qty) || 0;
    const rate = Number(line.rate) || 0;
    const gstRate = Number(line.gstRate) || 0;
    const lineTotal = round2(qty * rate);
    const tax = round2(lineTotal * gstRate / 100);

    if (!buckets.has(gstRate)) {
      buckets.set(gstRate, { rate: gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    }
    const bucket = buckets.get(gstRate);
    bucket.taxable += lineTotal;

    taxable += lineTotal;
    if (intraState) {
      const half = round2(tax / 2);
      cgst += half;
      sgst += round2(tax - half);
      bucket.cgst += half;
      bucket.sgst += round2(tax - half);
    } else {
      igst += tax;
      bucket.igst += tax;
    }
    return Object.assign({}, line, { lineTotal, taxAmount: tax });
  });

  /* One row per GST rate. A single "CGST @ 9%" line cannot describe an invoice
     that mixes an 18% hot plate with a 5% service, and the rate-wise breakup is
     what a GST invoice is supposed to carry anyway. */
  const byRate = Array.from(buckets.values()).map(function (b) {
    return {
      rate: b.rate,
      taxable: round2(b.taxable),
      cgst: round2(b.cgst),
      sgst: round2(b.sgst),
      igst: round2(b.igst)
    };
  }).sort(function (a, b) { return a.rate - b.rate; });

  taxable = round2(taxable);
  cgst = round2(cgst);
  sgst = round2(sgst);
  igst = round2(igst);

  const beforeRounding = round2(taxable + cgst + sgst + igst);
  const total = Math.round(beforeRounding);
  const rounding = round2(total - beforeRounding);

  return { lines: priced, intraState, taxable, cgst, sgst, igst, byRate, beforeRounding, rounding, total };
}

/* The rate-wise breakup for an invoice already saved. Nothing stores it, but
   each saved line carries its own gst_rate and tax_amount, which is enough to
   rebuild it — and the printed invoice needs it to state the tax honestly when
   rates differ across lines. */
function taxBreakupFromLines(lines, intraState) {
  const buckets = new Map();

  for (const line of lines || []) {
    const rate = Number(line.gst_rate) || 0;
    if (!buckets.has(rate)) {
      buckets.set(rate, { rate: rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    }
    const bucket = buckets.get(rate);
    bucket.taxable += Number(line.line_total) || 0;

    const tax = Number(line.tax_amount) || 0;
    if (intraState) {
      const half = round2(tax / 2);
      bucket.cgst += half;
      bucket.sgst += round2(tax - half);
    } else {
      bucket.igst += tax;
    }
  }

  return Array.from(buckets.values()).map(function (b) {
    return {
      rate: b.rate,
      taxable: round2(b.taxable),
      cgst: round2(b.cgst),
      sgst: round2(b.sgst),
      igst: round2(b.igst)
    };
  }).sort(function (a, b) { return a.rate - b.rate; });
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function underThousand(n) {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + underThousand(n % 100) : '');
}

function amountInWords(amount) {
  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);

  let words = '';
  if (rupees === 0) {
    words = 'zero';
  } else {
    const crore = Math.floor(rupees / 10000000);
    const lakh = Math.floor((rupees % 10000000) / 100000);
    const thousand = Math.floor((rupees % 100000) / 1000);
    const rest = rupees % 1000;
    const parts = [];
    if (crore) parts.push(underThousand(crore) + ' crore');
    if (lakh) parts.push(underThousand(lakh) + ' lakh');
    if (thousand) parts.push(underThousand(thousand) + ' thousand');
    if (rest) parts.push(underThousand(rest));
    words = parts.join(' ');
  }

  let out = 'Rupees ' + words;
  if (paise) out += ' and ' + underThousand(paise) + ' paise';
  return out.replace(/\s+/g, ' ') + ' only';
}

module.exports = {
  validateGstin,
  gstinCheckDigit,
  financialYear,
  buildInvoiceNumber,
  periodKey,
  seriesPrefix,
  computeInvoice,
  taxBreakupFromLines,
  amountInWords,
  round2
};
