'use strict';

/* Finding the header row in a distributor portal export.

   The exports are not clean tables. They open with a title, the agency name,
   a date range, sometimes a blank row or two, and only then the column
   headings — row 3, row 4, occasionally row 7. Reading row 1 as the header,
   which is what sheet_to_json does, gives columns called "Consumer list" and
   "__EMPTY_3" and nothing maps.

   So every row near the top is scored on how much it looks like a heading
   row rather than a data row, and the best one wins. */

const FIELDS = {
  consumer_no: {
    label: 'Consumer number',
    exact: ['consumer_no', 'consumerno', 'consumer no', 'consumer number', 'consumer_number',
      'cons_no', 'consno', 'cons no', 'cust_no', 'customer no', 'customer number',
      'lpg id', 'lpgid', 'consumer id', 'account no', 'ac no'],
    contains: ['consumer', 'cons no', 'cust no', 'lpg id']
  },
  name: {
    label: 'Customer name',
    exact: ['name', 'cons_name', 'consumer name', 'consumer_name', 'customer name',
      'customer_name', 'cust_name', 'party name', 'consumer/customer name'],
    contains: ['name']
  },
  address: {
    label: 'Address',
    exact: ['address', 'address1', 'address_1', 'addr', 'address 1', 'full address',
      'consumer address', 'residential address'],
    contains: ['address', 'addr']
  },
  mobile: {
    label: 'Mobile',
    exact: ['mobile_no', 'mobileno', 'mobile no', 'mobile', 'mobile number', 'phone',
      'phone no', 'contact', 'contact no', 'contact number', 'cell', 'cell no'],
    contains: ['mobile', 'phone', 'contact']
  }
};

function norm(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Which field a heading names, or null. Exact matches across every field are
   tried before any loose one, so a sheet with both "Name" and "Consumer
   Name" does not hand "Name" to the consumer-number field on a substring. */
function fieldForHeading(heading, pass) {
  const n = norm(heading);
  if (!n) return null;
  for (const key of Object.keys(FIELDS)) {
    const f = FIELDS[key];
    if (pass === 'exact') {
      if (f.exact.some(function (e) { return norm(e) === n; })) return key;
    } else if (f.contains.some(function (c) { return n.indexOf(norm(c)) >= 0; })) {
      return key;
    }
  }
  return null;
}

function looksNumeric(v) {
  const s = String(v == null ? '' : v).trim();
  return s !== '' && /^[\d.,/\-\s]+$/.test(s);
}

/* A heading is short, has letters, and is not a number or a date. */
function looksLikeHeading(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 60) return false;
  if (looksNumeric(s)) return false;
  return /[a-z]/i.test(s);
}

function rowCells(row) {
  return (row || []).map(function (c) { return c == null ? '' : String(c).trim(); });
}

/* Scores a row as a candidate header. Recognised field names are what
   really count; the rest is shape — several short texty cells, with a row
   of data under it that fills about as many columns. */
function scoreRow(matrix, index) {
  const cells = rowCells(matrix[index]);
  const filled = cells.filter(function (c) { return c !== ''; });
  if (filled.length < 2) return -1;

  const matched = new Set();
  let headingLike = 0;
  let numeric = 0;
  for (const cell of filled) {
    const key = fieldForHeading(cell, 'exact') || fieldForHeading(cell, 'loose');
    if (key) matched.add(key);
    if (looksLikeHeading(cell)) headingLike++;
    if (looksNumeric(cell)) numeric++;
  }

  /* A row with figures in it and not one recognisable field name is data.
     Without this, the first row of a file that has no header at all scores
     well enough to be eaten as one. */
  if (matched.size === 0 && numeric > 0) return -1;

  let score = matched.size * 12 + headingLike * 2 - numeric * 3;

  // A header row is followed by data, and the data fills a similar number of
  // columns. A stray title line has nothing lined up beneath it.
  const below = rowCells(matrix[index + 1]).filter(function (c) { return c !== ''; });
  if (below.length >= Math.max(2, Math.floor(filled.length * 0.6))) score += 6;
  else score -= 4;

  // Repeating the same word across cells is a banner, not headings.
  const distinct = new Set(filled.map(norm));
  if (distinct.size < filled.length) score -= 2;

  // All else equal, the earlier row wins.
  return score - index * 0.1;
}

function detectHeaderRow(matrix, limit) {
  const last = Math.min(matrix.length, limit || 25);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < last; i++) {
    const score = scoreRow(matrix, i);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/* Blank and duplicate headings still have to address a column, so they get
   a spreadsheet-style name — the user can see which column it is. */
function columnLetter(i) {
  let out = '';
  let n = i;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function headerNames(cells, width) {
  const out = [];
  const seen = new Map();
  for (let i = 0; i < width; i++) {
    let name = (cells[i] || '').replace(/\s+/g, ' ').trim();
    if (!name) name = 'Column ' + columnLetter(i);
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      name = name + ' (' + n + ')';
    } else {
      seen.set(name, 1);
    }
    out.push(name);
  }
  return out;
}

/* Turns a sheet-as-matrix into { headers, rows, headerRow, guess }.
   `headerRow` is 1-based for showing the user; -1 means no header row was
   found and the columns are named by letter, which still imports fine once
   the columns are picked by hand. */
function readMatrix(matrix) {
  const width = matrix.reduce(function (w, r) { return Math.max(w, (r || []).length); }, 0);
  if (!width) return { headers: [], rows: [], headerRow: -1, guess: {} };

  const at = detectHeaderRow(matrix);
  const headers = at >= 0
    ? headerNames(rowCells(matrix[at]), width)
    : headerNames([], width);

  const rows = [];
  for (let i = (at >= 0 ? at + 1 : 0); i < matrix.length; i++) {
    const cells = rowCells(matrix[i]);
    if (!cells.some(function (c) { return c !== ''; })) continue;
    const row = {};
    for (let c = 0; c < width; c++) row[headers[c]] = cells[c] || '';
    rows.push(row);
  }

  return { headers: headers, rows: rows, headerRow: at + 1 || -1, guess: guessColumns(headers, rows) };
}

/* Which column holds which field. Headings decide it when they are
   recognisable; when they are not — a file with no header row at all — the
   data itself is read: a column of ten-digit numbers starting 6 to 9 is a
   mobile, a column of long digit strings is a consumer number. */
function guessColumns(headers, rows) {
  const guess = {};
  const taken = new Set();

  for (const pass of ['exact', 'loose']) {
    headers.forEach(function (h) {
      if (taken.has(h)) return;
      const key = fieldForHeading(h, pass);
      if (!key || guess[key]) return;
      guess[key] = h;
      taken.add(h);
    });
  }

  const sample = rows.slice(0, 40);
  const share = function (header, test) {
    const values = sample.map(function (r) { return String(r[header] || '').trim(); })
      .filter(function (v) { return v !== ''; });
    if (values.length < 3) return 0;
    return values.filter(test).length / values.length;
  };

  if (!guess.mobile) {
    for (const h of headers) {
      if (taken.has(h)) continue;
      if (share(h, function (v) { return /^(\+?91[\s-]?)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, '')); }) > 0.7) {
        guess.mobile = h;
        taken.add(h);
        break;
      }
    }
  }
  if (!guess.consumer_no) {
    for (const h of headers) {
      if (taken.has(h)) continue;
      if (share(h, function (v) { return /^\d{6,18}$/.test(v); }) > 0.8) {
        guess.consumer_no = h;
        taken.add(h);
        break;
      }
    }
  }
  if (!guess.name) {
    for (const h of headers) {
      if (taken.has(h)) continue;
      if (share(h, function (v) { return /^[A-Za-z][A-Za-z .'\-]{2,}$/.test(v) && v.indexOf(' ') > 0; }) > 0.7) {
        guess.name = h;
        taken.add(h);
        break;
      }
    }
  }
  return guess;
}

module.exports = { readMatrix, detectHeaderRow, guessColumns, headerNames, FIELDS };
