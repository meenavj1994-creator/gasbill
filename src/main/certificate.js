'use strict';

const gst = require('../shared/gst');

const GSTIN_PATTERN = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;

function normalise(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function findGstin(text, expectedStateCode) {
  const candidates = normalise(text).toUpperCase().match(GSTIN_PATTERN) || [];
  const seen = [];

  for (const candidate of candidates) {
    if (seen.indexOf(candidate) >= 0) continue;
    seen.push(candidate);
    const check = gst.validateGstin(candidate, null);
    if (!check.valid) continue;
    if (expectedStateCode && candidate.slice(0, 2) !== expectedStateCode) continue;
    return { gstin: candidate, candidates: seen };
  }
  return { gstin: null, candidates: seen };
}

function fieldAfterLabel(text, labels) {
  const lines = normalise(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of labels) {
      const idx = line.toLowerCase().indexOf(label.toLowerCase());
      if (idx < 0) continue;

      const sameLine = line.slice(idx + label.length).replace(/^[\s:.\-]+/, '').trim();
      if (sameLine && sameLine.length > 1) return sameLine;

      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const next = lines[j].trim();
        if (next && !/^[\s:.\-]*$/.test(next)) return next;
      }
    }
  }
  return null;
}

function parseCertificate(text, options) {
  const opts = options || {};
  const expectedStateCode = opts.expectedStateCode || null;
  const clean = normalise(text);

  if (clean.length < 40) {
    return {
      ok: false,
      reason: 'Almost no text came out of the file. If it is a scan, OCR did not read it — enter the details manually.',
      fields: {}
    };
  }

  const found = findGstin(clean, expectedStateCode);

  const fields = {
    gstin: found.gstin,
    legal_name: fieldAfterLabel(clean, ['Legal Name of Business', 'Legal Name']),
    trade_name: fieldAfterLabel(clean, ['Trade Name, if any', 'Trade Name']),
    constitution: fieldAfterLabel(clean, ['Constitution of Business', 'Constitution']),
    address: fieldAfterLabel(clean, ['Address of Principal Place of Business', 'Principal Place of Business'])
  };

  if (!fields.gstin) {
    return {
      ok: false,
      reason: found.candidates.length
        ? 'A GSTIN-shaped string was found but its check digit does not match, so it was read wrongly. Type it in manually.'
        : 'No valid GSTIN was found in the file. Type the details in manually.',
      fields: fields,
      rejected: found.candidates
    };
  }

  const missing = ['legal_name', 'trade_name', 'address'].filter(function (k) { return !fields[k]; });

  return {
    ok: true,
    fields: fields,
    missing: missing,
    note: 'Check every field against the certificate before saving, especially the GSTIN.'
  };
}

module.exports = { parseCertificate, findGstin, normalise };
