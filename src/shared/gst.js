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

/* GST state codes, as carried in the first two characters of a GSTIN. */
const STATE_NAMES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory'
};

function stateName(code) {
  return STATE_NAMES[String(code || '').padStart(2, '0')] || null;
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
  return {
    valid: true, gstin, stateCode: gstin.slice(0, 2), pan: gstin.slice(2, 12),
    stateName: stateName(gstin.slice(0, 2))
  };
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

/* Local calendar date as YYYY-MM-DD. toISOString() gives the UTC date, which
   east of Greenwich is yesterday for the first few hours of every morning —
   an invoice raised at 8am IST must not carry yesterday's date. */
function localDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

/* Splits an invoice-level discount across lines in proportion to their gross
   value, in paise, with the last line taking whatever rounding leaves over so
   the shares always add up to exactly the discount given. */
function apportionDiscount(grossValues, discount) {
  const grossTotal = grossValues.reduce(function (a, b) { return a + b; }, 0);
  const shares = grossValues.map(function () { return 0; });
  if (!(discount > 0) || grossTotal <= 0) return shares;

  let allocated = 0;
  let last = -1;
  grossValues.forEach(function (g, i) {
    if (g <= 0) return;
    shares[i] = round2(discount * g / grossTotal);
    allocated = round2(allocated + shares[i]);
    last = i;
  });
  if (last >= 0) shares[last] = round2(shares[last] + (discount - allocated));
  return shares;
}

/* Discount is given per line — the counter knocks Rs 20 off *this* hot
   plate, not off the bill — and is applied to the value *before* tax, because
   Section 15(3) only excludes a discount from taxable value when it is
   recorded on the invoice against the supply. A discount taken off the grand
   total after tax would leave GST payable on money never collected.

   A line's discount is in the same basis as its rate: on an `inclusive` line
   (price quoted with GST inside it) the discount comes off the quoted price
   and the tax is re-derived from what the customer actually pays, so Rs 10
   off a Rs 190 tube means Rs 180 paid, 152.54 + 27.46. On file the line's
   discount is kept in the basic (pre-tax) basis, matching the Basic column
   it prints beside.

   `nonGst` lines are refundable deposits: they print, they add to the total,
   and they are outside GST — not taxable, not exempt, not in the return.
   They carry no discount either.

   An invoice-level `discount` is still accepted and apportioned across lines
   by basic value when no line carries its own; nothing on screen sends one
   any more. */
function computeInvoice(lines, supplierStateCode, placeOfSupplyCode, discount) {
  const intraState = supplierStateCode === placeOfSupplyCode;
  let taxable = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  let nonGst = 0;
  let totalDiscount = 0;
  const buckets = new Map();

  const quoted = lines.map(function (line) {
    return round2((Number(line.qty) || 0) * (Number(line.rate) || 0));
  });
  const factor = function (line) {
    return line.inclusive ? 1 + (Number(line.gstRate) || 0) / 100 : 1;
  };
  // Basic (pre-tax) value of each GST line; zero for deposits.
  const basics = lines.map(function (line, i) {
    return line.nonGst ? 0 : round2(quoted[i] / factor(line));
  });
  const gross = round2(basics.reduce(function (a, b) { return a + b; }, 0));

  // Per-line discounts, clamped to the line, in the line's own basis.
  const anyLineDiscount = lines.some(function (l) { return !l.nonGst && Number(l.discount) > 0; });
  let lineDiscounts = lines.map(function (line, i) {
    if (line.nonGst) return 0;
    return round2(Math.min(Math.max(Number(line.discount) || 0, 0), quoted[i]));
  });
  if (!anyLineDiscount) {
    const invoiceLevel = round2(Math.min(Math.max(Number(discount) || 0, 0), gross));
    // Apportioned in basic terms; converted to each line's basis below.
    const shares = apportionDiscount(basics, invoiceLevel);
    lineDiscounts = shares.map(function (s, i) { return round2(s * factor(lines[i])); });
  }

  const priced = lines.map(function (line, i) {
    const gstRate = line.nonGst ? 0 : (Number(line.gstRate) || 0);

    if (line.nonGst) {
      nonGst += quoted[i];
      return Object.assign({}, line, {
        gross: quoted[i], discount: 0, lineTotal: quoted[i], taxAmount: 0,
        cgst: 0, sgst: 0, igst: 0, lineWithTax: quoted[i], gstRate: 0
      });
    }

    const net = round2(quoted[i] - lineDiscounts[i]);
    let lineTotal;
    let tax;
    if (line.inclusive) {
      // What the customer pays is the quoted price less the discount; the
      // basic and the tax are both derived from that, so it lands exactly.
      lineTotal = round2(net / factor(line));
      tax = round2(net - lineTotal);
    } else {
      lineTotal = net;
      tax = round2(lineTotal * gstRate / 100);
    }
    const discountBasic = round2(basics[i] - lineTotal);
    totalDiscount += discountBasic;

    if (!buckets.has(gstRate)) {
      buckets.set(gstRate, { rate: gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    }
    const bucket = buckets.get(gstRate);
    bucket.taxable += lineTotal;

    taxable += lineTotal;
    let lineCgst = 0;
    let lineSgst = 0;
    let lineIgst = 0;
    if (intraState) {
      lineCgst = round2(tax / 2);
      lineSgst = round2(tax - lineCgst);
      cgst += lineCgst;
      sgst += lineSgst;
      bucket.cgst += lineCgst;
      bucket.sgst += lineSgst;
    } else {
      lineIgst = tax;
      igst += tax;
      bucket.igst += tax;
    }
    return Object.assign({}, line, {
      gross: basics[i],
      discount: discountBasic,
      lineTotal,
      taxAmount: tax,
      cgst: lineCgst,
      sgst: lineSgst,
      igst: lineIgst,
      lineWithTax: round2(lineTotal + tax)
    });
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
  nonGst = round2(nonGst);
  totalDiscount = round2(totalDiscount);

  const beforeRounding = round2(taxable + cgst + sgst + igst + nonGst);
  const total = Math.round(beforeRounding);
  const rounding = round2(total - beforeRounding);

  return { lines: priced, intraState, gross, discount: totalDiscount, taxable, cgst, sgst, igst, nonGst, byRate, beforeRounding, rounding, total };
}

/* The rate-wise breakup for an invoice already saved. Nothing stores it, but
   each saved line carries its own gst_rate and tax_amount, which is enough to
   rebuild it — and the printed invoice needs it to state the tax honestly when
   rates differ across lines. */
function taxBreakupFromLines(lines, intraState) {
  const buckets = new Map();

  for (const line of lines || []) {
    if (line.non_gst) continue;
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
  localDate,
  apportionDiscount,
  stateName,
  STATE_NAMES,
  round2
};
