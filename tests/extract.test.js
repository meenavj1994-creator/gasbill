'use strict';

const assert = require('assert');
const path = require('path');
const { extractText, rasterisePdf, ocr } = require('../src/main/extract');
const { parseCertificate } = require('../src/main/certificate');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-reg06.pdf');
const TESSDATA = path.join(__dirname, '..', 'resources', 'tessdata');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    console.log('  FAIL ' + name + '\n       ' + err.message);
    process.exitCode = 1;
  }
}

(async function () {
  console.log('\nText layer');

  await test('reads a REG-06 text layer and parses every field', async function () {
    const result = await extractText(FIXTURE);
    assert.strictEqual(result.method, 'text-layer');
    const parsed = parseCertificate(result.text, { expectedStateCode: '23' });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.fields.gstin, '23ABCDE1234F1Z8');
    assert.strictEqual(parsed.fields.trade_name, 'Shree Balaji Gas Agency');
  });

  console.log('\nRasterise and OCR fallback');

  await test('renders a page with actual ink on it', async function () {
    const pages = await rasterisePdf(FIXTURE, 300);
    assert.strictEqual(pages.length, 1);
    assert.ok(pages[0].length > 100000,
      'PNG is only ' + pages[0].length + ' bytes — the page rendered blank. ' +
      'Check useSystemFonts and standardFontDataUrl in extract.js.');
  });

  await test('OCR reads a rendered page well enough to pass the checksum', async function () {
    const pages = await rasterisePdf(FIXTURE, 300);
    const text = await ocr(pages, TESSDATA);
    assert.ok(text.length > 100, 'OCR returned ' + text.length + ' characters.');
    const parsed = parseCertificate(text, { expectedStateCode: '23' });
    assert.strictEqual(parsed.ok, true, parsed.reason || '');
    assert.strictEqual(parsed.fields.gstin, '23ABCDE1234F1Z8');
  });

  console.log('\n' + passed + ' passed\n');
})();
