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

/* A GSTIN has a fixed shape — two digits, five letters, four digits, a letter,
   an entity character, the letter Z, a check character — so most of what OCR
   gets wrong on a scan can be put right without guessing: a 7 in the Z slot
   was a Z, an O among the digits was a 0. Only positions with a known class
   are touched; the entity and check characters are left exactly as read, and
   the check digit still has to pass. Repairing the check character itself
   until it passed would prove nothing. */
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6', T: '7' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G', 4: 'A' };

function repairGstin(token) {
  const chars = token.toUpperCase().split('');
  if (chars.length !== 15) return null;
  const digitAt = [0, 1, 7, 8, 9, 10];
  const letterAt = [2, 3, 4, 5, 6, 11];
  for (const i of digitAt) if (TO_DIGIT[chars[i]]) chars[i] = TO_DIGIT[chars[i]];
  for (const i of letterAt) if (TO_LETTER[chars[i]]) chars[i] = TO_LETTER[chars[i]];
  chars[13] = 'Z';
  const fixed = chars.join('');
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(fixed) ? fixed : null;
}

/* Candidate strings in rough order of trust: exact matches first, then
   15-character tokens (spaces stripped, so "1234F 178" and "1234F178" are the
   same token), each run through repairGstin. */
function gstinCandidates(text) {
  const upper = normalise(text).toUpperCase();
  const out = [];
  const push = function (c) { if (c && out.indexOf(c) < 0) out.push(c); };

  (upper.match(GSTIN_PATTERN) || []).forEach(push);

  for (const line of upper.split('\n')) {
    // A space inside the number is OCR's doing; a colon or label is not.
    const squashed = line.replace(/(?<=[0-9A-Z]) (?=[0-9A-Z])/g, '');
    for (const token of squashed.split(/[^0-9A-Z]+/)) {
      if (token.length === 15) push(repairGstin(token));
    }
  }
  return out;
}

function findGstin(text, expectedStateCode) {
  const candidates = gstinCandidates(text);
  for (const candidate of candidates) {
    const check = gst.validateGstin(candidate, null);
    if (!check.valid) continue;
    if (expectedStateCode && candidate.slice(0, 2) !== expectedStateCode) continue;
    return { gstin: candidate, candidates: candidates };
  }
  return { gstin: null, candidates: candidates };
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
    const others = ['legal_name', 'trade_name', 'address'].filter(function (k) { return fields[k]; });
    return {
      ok: false,
      reason: (found.candidates.length
        ? 'The GSTIN could not be read reliably from this scan.'
        : 'No GSTIN was found in the file.') +
        (others.length
          ? ' The other details were read — type the GSTIN from the certificate and check everything.'
          : ' Type the details in manually.'),
      fields: fields,
      partial: others.length > 0,
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

module.exports = { parseCertificate, findGstin, repairGstin, normalise };
