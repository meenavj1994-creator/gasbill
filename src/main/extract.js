'use strict';

const fs = require('fs');
const path = require('path');

function installCanvasGlobals() {
  const canvasLib = require('@napi-rs/canvas');
  for (const name of ['DOMMatrix', 'Path2D', 'ImageData', 'Image']) {
    if (!globalThis[name] && canvasLib[name]) globalThis[name] = canvasLib[name];
  }
}

/* pdf.js 4 ships as an ES module only. Plain Node 22 will require() one,
   but the Node inside Electron 33 (20.x) will not, so the tests passed while
   the app itself threw on every certificate. Dynamic import() works in both. */
let pdfjsModule = null;
function loadPdfjs() {
  if (!pdfjsModule) {
    const { pathToFileURL } = require('url');
    pdfjsModule = import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  }
  return pdfjsModule;
}

function pdfjsAsset(name) {
  return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name) + path.sep;
}

function documentOptions(data) {
  return {
    data: data,
    useSystemFonts: false,
    standardFontDataUrl: pdfjsAsset('standard_fonts'),
    cMapUrl: pdfjsAsset('cmaps'),
    cMapPacked: true
  };
}

async function pdfTextLayer(filePath) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument(documentOptions(data)).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    let line = [];
    const lines = [];

    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.join(' '));
        line = [];
      }
      if (item.str.trim()) line.push(item.str.trim());
      lastY = y;
    }
    if (line.length) lines.push(line.join(' '));
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n');
}

async function rasterisePdf(filePath, dpi) {
  installCanvasGlobals();
  const pdfjs = await loadPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');

  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument(documentOptions(data)).promise;
  const buffers = [];

  const pageCount = Math.min(doc.numPages, 3);
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: (dpi || 300) / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: viewport, canvas: canvas }).promise;
    buffers.push(canvas.toBuffer('image/png'));
  }
  await doc.destroy();
  return buffers;
}

async function ocr(buffers, traineddataDir) {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng', 1, {
    langPath: traineddataDir,
    cachePath: traineddataDir,
    gzip: false
  });

  try {
    const chunks = [];
    for (const buffer of buffers) {
      const result = await worker.recognize(buffer);
      chunks.push(result.data.text);
    }
    return chunks.join('\n');
  } finally {
    await worker.terminate();
  }
}

async function extractText(filePath, options) {
  const opts = options || {};
  const traineddataDir = opts.traineddataDir || path.join(__dirname, '..', '..', 'resources', 'tessdata');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    try {
      const text = await pdfTextLayer(filePath);
      if (text && text.replace(/\s/g, '').length > 60) {
        return { text: text, method: 'text-layer' };
      }
    } catch (err) {
      console.error('text layer failed:', err.message);
    }

    try {
      const pages = await rasterisePdf(filePath, 300);
      const text = await ocr(pages, traineddataDir);
      return { text: text, method: 'ocr' };
    } catch (err) {
      // @napi-rs/canvas has no 32-bit build, so a scanned PDF cannot be
      // rasterised on 32-bit Windows. Photos and JPG scans still read fine.
      const noCanvas = process.arch === 'ia32' || /canvas/i.test(err.message);
      return {
        text: '',
        method: 'failed',
        error: noCanvas
          ? 'This is a scanned PDF and scanned PDFs cannot be read on 32-bit Windows. Upload a photo or JPG of the certificate instead'
          : err.message
      };
    }
  }

  try {
    const text = await ocr([fs.readFileSync(filePath)], traineddataDir);
    return { text: text, method: 'ocr' };
  } catch (err) {
    return { text: '', method: 'failed', error: err.message };
  }
}

module.exports = { extractText, pdfTextLayer, rasterisePdf, ocr };
