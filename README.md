# GasBill

Offline Windows desktop app for LPG distributors to raise GST tax invoices for
service charges. No server, no hosting, no internet needed to run.

## Running it

    npm install
    npm test          # 45 fast tests
    npm run test:all  # adds 3 OCR tests (~10s, needs eng.traineddata)
    npm start         # run the app
    npm run dist      # build the Windows NSIS installer

`eng.traineddata` is already in `resources/tessdata/` (23 MB), so OCR of a
scanned certificate works offline out of the box.

**Node 22 LTS is required.** On Node 23 or newer, `better-sqlite3` has no
prebuilt binary and falls back to compiling from source, which needs a C++
toolchain most Windows machines don't have.

### The native module has two builds

`better-sqlite3` is compiled C++, and Electron uses a different Node ABI than
plain Node. So the same file cannot serve both.

- `npm start` and `npm run dist` need the **Electron** build — `npm run rebuild`
- `npm test` needs the **Node** build — `npm run rebuild:node`

`postinstall` produces the Electron build, and `pretest`/`posttest` swap it and
put it back, so both commands work without you thinking about it. If `npm start`
ever fails with NODE_MODULE_VERSION, run `npm run rebuild`.

`npm run dist` performs its own rebuild internally, so the installer is
unaffected by whichever build is currently on disk.

## Before shipping to a distributor

1. **Confirm every seeded charge.** They are inserted with
   `needs_confirmation = 1`, deliberately. The app shows a banner until they
   are confirmed against the current territory circular.
2. **Have a CA review** the printed invoice template and the B2CS sheet.

## Auto-update

`package.json`'s `build.publish` points at
[meenavj1994-creator/gasbill](https://github.com/meenavj1994-creator/gasbill)
on GitHub (public, so no token is needed at update-check time). The packaged
app checks for updates once on launch — `src/main/main.js`'s
`checkForUpdates()`, guarded by `app.isPackaged` so it's a no-op under
`npm start`. When a newer version has finished downloading in the background,
a banner appears on the billing screen with a "Restart to update" button.

To cut a release: bump `version` in `package.json`, generate a GitHub
personal access token with `public_repo` scope, then run (PowerShell)

    $env:GH_TOKEN = "<token>"
    npm run dist

or (bash)

    GH_TOKEN=<token> npm run dist

Two separate settings both have to be right, and only one of them is the
`--publish always` flag that `npm run dist` passes. That flag decides
*whether* to upload at all; `build.publish[].releaseType` decides what state
the release lands in, and electron-builder defaults it to `draft`. A draft is
invisible to the updater and to anyone not logged in as you, so a build that
reports success can still reach nobody. `releaseType: "release"` is set for
exactly this reason — if a release ever shows a **Draft** badge on GitHub, no
installed copy will see it until it's published.

After publishing, check
[the releases page](https://github.com/meenavj1994-creator/gasbill/releases):
the newest entry should say **Latest**, not **Draft**, and carry three assets
(`.exe`, `.exe.blockmap`, `latest.yml`).

An installed copy checks on launch, downloads in the background, and shows the
banner when the file is ready. It does not have to be the button that applies
it — `autoInstallOnAppQuit` is on by default, so an update the user ignores
still installs the next time they close the app.

Pushing to `main` publishes nothing. Only `npm run dist` cuts a release.

## The two copies

Every invoice prints twice and they are not the same document.

**Original for recipient** — the customer's copy. Rule 46 particulars, agency
signature only.

**Duplicate for supplier** — the distributor's record. Terser (tax on one line,
no place-of-supply block) to make room for a boxed acknowledgement sentence and
a customer signature block with name and date. That signed duplicate is the
distributor's evidence that the service was performed and the original handed
over. The acknowledgement wording is set during setup and stored per
distributor — have a CA check it.

## Keyboard

The billing screen is built to be worked without a mouse.

| Key | Does |
|---|---|
| `Ctrl N` | Start a fresh invoice |
| `Ctrl K` | Jump to the charge dropdown |
| `Ctrl S` | Save without printing |
| `Ctrl P` | Save and print |
| `↑ ↓` | Move through consumer search results |
| `Enter` | Pick the highlighted consumer, or add the selected charge |

Typing in the consumer field searches by number or name as you type — no
dropdown needs opening. Charges are picked from a dropdown of the active
charge list and added with the Add button (or Enter).

Closing the app with an invoice half-finished does not save it — there is no
draft recovery. Whatever was on screen is gone on next launch.

## Screens

- `index.html` — billing. Consumer lookup, editable customer fields, charge
  lines with quantity, live totals, save and print.
- `setup.html` — first run. Certificate upload with field extraction, GSTIN
  validation, series prefix with a live length check, backup folder.
- `charges.html` — charges master. Add, confirm, and revise rates.
- `consumers.html` — XLSX/CSV import with column mapping and guessed defaults.
- `reports.html` — workbook export by financial year, month, or custom dates.

## Modules

- `src/shared/gst.js` — GSTIN checksum, CGST/SGST split, financial year,
  invoice numbering, amount in words.
- `src/main/migrations.js` — versioned schema, runs on launch.
- `src/main/repository.js` — transactional numbering, charge versioning,
  consumer upsert.
- `src/main/certificate.js` — REG-06 field extraction, checksum-gated.
- `src/main/extract.js` — pdf.js text layer first, Tesseract OCR fallback at
  300 DPI.
- `src/main/reports.js` — six report sheets.
- `src/main/main.js` — Electron shell, IPC, backup on close.

## Design decisions worth keeping

Invoice lines store copied values, not references to the charges table, so a
later rate revision cannot alter a past invoice. Revising a rate inserts a new
row and deactivates the old one; nothing is updated in place. The invoice
counter increments inside the same transaction as the insert, so a failed save
does not consume a number. A GSTIN read from a certificate is rejected unless
its check digit passes, so a misread is never shown as if it were confirmed.
Printing uses a `@media print` stylesheet and `window.print()`, not
html2canvas, so text stays selectable and Save as PDF works from the dialog.

## Printing

Both copies print on **one A4 sheet**, roughly half each, separated by a dashed
cut line. Each half is `min-height: 134mm` — with 9mm page margins that leaves
about 7mm of slack, so a normal invoice of two to five charge lines fits
comfortably.

`min-height` rather than a fixed height is deliberate. A very long invoice runs
onto a second sheet instead of being silently clipped; losing a charge line off
the bottom of a tax invoice would be far worse than an extra page.

A5 and 80mm modes revert to one copy per page.

## Theme

Arctic Frost chrome with Botanical Garden signal colours:

| Token | Hex | Used for |
|---|---|---|
| Steel blue | `#4A6FA5` | Header, totals, focus |
| Ice blue | `#D4E4F7` | Customer card, selected rows |
| Charcoal | `#36454F` | Body text |
| Slate | `#708090` | Labels |
| Silver | `#C0C0C0` | Rules and borders |
| Cream | `#F5F3ED` | Page background |
| Fern green | `#4A7C59` | Save and print, only |
| Marigold | `#F9A620` | Unconfirmed charges, only |
| Terracotta | `#B7472A` | Errors, only |

Structure follows an 8px spacing scale with a matching radius and shadow scale,
pill-shaped buttons, a 44px minimum height on every control, and 150–300ms
transitions on a single easing curve. Motion is disabled under
`prefers-reduced-motion`. Glassmorphism was deliberately left out — translucent
blurred panels reduce legibility on the low-end monitors these run on.

The billing screen is a two-column layout on windows over 900px — charges left,
totals and actions in a sticky right rail — collapsing to one column below that.
The printed invoice stays black on white regardless of the screen theme.

## One trap worth knowing about

`useSystemFonts` must stay `false` in `extract.js`. With it on, pdf.js finds no
system fonts and renders every page blank white — no error, no warning, just an
empty image that OCR reads as zero characters. `tests/extract.test.js` guards
against this by asserting the rendered PNG is over 100 KB.

## Still to build

Credit notes UI (the table and report sheet exist, the screen does not),
electron-updater wiring, and a settings screen for the backup folder and page
size after first run.
