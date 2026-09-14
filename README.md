# GasBill

Offline Windows desktop app for LPG distributors to raise GST tax invoices for
service charges. No server, no hosting, no internet needed to run.

## Running it

    npm install
    npm test          # 101 fast tests
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
draft recovery. Whatever was on screen is gone on next launch. A saved
invoice can be corrected or removed from the Invoices page.

## Screens

- `index.html` — billing. Consumer lookup, editable customer fields, charge
  lines with quantity, live totals, save and print.
- `setup.html` — first run. Certificate upload with field extraction, GSTIN
  validation, series prefix with a live length check, backup folder.
- `charges.html` — charges, products and sets. Add, confirm and revise items,
  and group the ones that get billed together.
- `consumers.html` — XLSX/CSV import with column mapping and guessed defaults.
- `invoices.html` — every invoice on file, filtered by month, financial year
  or custom dates, searchable by number, customer or consumer. Reprint, edit,
  delete.
- `reports.html` — workbook export by financial year, month, or custom dates.
- `settings.html` — edit the business details, logo, series prefix,
  acknowledgement wording and backup folder after first run. `saveDistributor`
  writes every column, so this screen round-trips the fields it does not edit
  rather than letting them fall to null.

## Modules

- `src/shared/gst.js` — GSTIN checksum, CGST/SGST split, financial year,
  invoice numbering, amount in words.
- `src/main/migrations.js` — versioned schema, runs on launch.
- `src/main/repository.js` — transactional numbering, charge versioning,
  consumer upsert.
- `src/main/certificate.js` — REG-06 field extraction, checksum-gated, with
  shape-based repair of OCR confusions (see Scanned certificates).
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
Printing uses a `@media print` stylesheet rendered to PDF by
`webContents.printToPDF`, not html2canvas, so text stays selectable.

## Printing

Electron has no print preview: `webContents.print()` goes straight to the
Windows printer dialog, and the user commits to paper without seeing the
page. So Print renders the invoice to a PDF and opens it in a preview window
— Chromium's PDF viewer, with its own Print and Save buttons — and what
prints is exactly what was looked at. The file is named after the invoice so
Save suggests `SH-2627-09-0002.pdf`, lives in the OS temp folder, and is
deleted when the preview closes (leftovers from a crash are swept at
startup).

Both copies print on **one A4 sheet**, roughly half each, separated by a dashed
cut line. Each half is `min-height: 134mm` — with 9mm page margins that leaves
about 7mm of slack, so a normal invoice of two to five charge lines fits
comfortably.

`min-height` rather than a fixed height is deliberate. A very long invoice runs
onto a second sheet instead of being silently clipped; losing a charge line off
the bottom of a tax invoice would be far worse than an extra page.

A5 and 80mm modes revert to one copy per page.

The layout follows what distributors already hand out: logo, agency name,
the "Authorised Distributor for Bharat Gas" line and address on top, TAX
INVOICE at the right; customer and invoice particulars in two quiet columns;
one table; one total. Thin rules, no filled bands, nothing labelled that
does not need a label. The tagline and an optional footer line ("Subject to
Ujjain jurisdiction") are set on the Settings page and print only if filled.

**Tax is carried in the line columns**, not in rows under the table:
Description | HSN/SAC | Qty | Basic | CGST (%) | SGST (%) | Total within the
state, with a single IGST column across state lines. Basic is the line amount before tax;
when quantity is not one the unit rate appears in small type beside it, so
there is no separate Rate column. Each tax cell shows the rate the same way.
A footer row totals every column. Rule 46 asks for taxable value, rate and
amount of tax; the columns give all three per line, and below the table
there is only what the footer cannot say — the taxable value when it differs
from the Basic column (a discount or a deposit), the deposit line, the
rounding, and the total. A plain invoice has two rows there.

A **Discount** column exists only on invoices that carry one, and so do the
"Less discount" and "Taxable value" rows below. Each line's tax is computed on
Basic less that line's share, so without the column the 9% beside it would
not reconcile to anything printed. A normal invoice has no discount column,
no discount row and no "0.00" — nothing about discounts is visible at all.

The layout was compacted so that both copies keep to one sheet with real
headroom: invoice number and date sit at the right of the supplier row rather
than in a strip of their own, recipient and place-of-supply sit side by side,
the totals float right beside the words and acknowledgement, and the signature
block is pinned to the bottom of each half (`.doc` is a flex column,
`margin-top: auto` on the signatures) so the cut line lands in the same place
on every invoice. Measured under print media: **seven lines with a discount,
eight without**, before the second copy spills to a second sheet. Anything
longer does spill rather than clip — see above.

The screen's gradient wash is a `body::before`, which `body { background: #fff }`
does not cover, so `print.css` hides it explicitly — printing runs with
`printBackground` on.

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
`prefers-reduced-motion`.

Surfaces are frosted glass over a fixed blue-and-gold wash. The earlier note
here said glassmorphism was left out because translucency hurts legibility on
low-end monitors; that concern is handled rather than ignored — blur is spent
on chrome (header, sheet, sections, dropdowns) while anything holding figures
sits on `--glass-solid`, which is opaque enough to keep text crisp.

**Entrance animations must never animate opacity.** Chromium freezes CSS
animations while it believes the window is occluded, and a running animation
applies its current frame whatever its fill-mode — so an `opacity: 0` start
frame does not resolve, it sticks, and the whole app renders blank. This
actually happened here. Structural chrome animates `transform` only, so a
frozen animation costs a few pixels of offset instead of the entire UI.

The billing screen is a two-column layout on windows over 900px — charges left,
totals and actions in a sticky right rail — collapsing to one column below that.
The printed invoice stays black on white regardless of the screen theme.

## Scanned certificates

Setup accepts the portal's PDF, a scanned PDF, or a photo (JPG/PNG). A PDF is
tried for a text layer first; anything without one is rasterised at 300 DPI
and read by Tesseract, offline, using the bundled `eng.traineddata`. A phone
photo of a REG-06 reads in one to three seconds.

OCR's classic slips — Z read as 7, O as 0, B as 8, a space dropped into the
middle of the number — are corrected by *shape*, not guesswork. A GSTIN is
two digits, five letters, four digits, a letter, an entity character, the
letter Z, a check character. `repairGstin` maps confusable characters in
every position whose class is fixed, forces the Z, and leaves the entity and
check characters exactly as read. The check digit then has to pass as usual;
repairing it until it did would prove nothing. Tokens are compared with
internal spaces removed, so `1234F 178` and `1234F178` are the same
candidate.

A scanned REG-06 states the GSTIN three times — the certificate, Annexure A,
Annexure B — and OCR tends to get a *different* character wrong in each, so
no single reading passes yet every position was read right somewhere.
`combineReadings` groups the repaired candidates by PAN, takes the set of
characters seen at each position, and tests every combination; exactly one
passing combination is accepted, none or several is reported as unreadable.
The search is capped at 64 combinations because the check digit is a 1-in-36
check and a wide search would eventually "find" something. This is what
recovered a real Gujarat certificate that read `2dAFM…ZS`, `24AFM…Z8` and
`24AFM…05…` on its three pages.

The current REG-06 lays the address out as labelled parts, one per line —
Floor No., Building No., Road/Street, Landmark, City, District, State, PIN —
and OCR bends the labels ("Fioor No."). `structuredAddress` matches each
loosely and joins the parts in order; `cleanValue` strips the debris OCR
leaves at the ends of values ("Gujarat. | +"). Whatever it gets wrong is on
screen to be corrected before saving.

**The state comes from the GSTIN, never from a constant.** Setup used to
hard-code Madhya Pradesh (state 23) and the billing screen printed it as
place of supply. A Gujarat distributor's certificate was rejected as "wrong
state" before it was even read properly. Now `state_code` is the GSTIN's
first two characters, `gst.stateName` maps it, and place of supply follows
the distributor.

When the GSTIN still cannot be read, the names and address that *were* read
are filled in anyway and the cursor goes to the GSTIN field — a scan that
loses one character should not cost the user the other four fields.

All three inputs are verified against the packaged build, not just
`npm start`: the trained data and pdf.js both live inside `app.asar` and
both are read from a worker thread, which is exactly the kind of thing that
works in development and not in an installer.

## Traps worth knowing about

**`File.path` does not exist.** Electron 32 removed it from the renderer, so
every file input goes through `window.api.pathOf(file)`, which is
`webUtils.getPathForFile` behind the preload bridge. Reading `.path` off a
`File` gives `undefined` and the main process then fails with
`The "path" argument must be of type string`, which is what a distributor
actually saw on the setup screen.

**Invoice dates come from `gst.localDate`, never `toISOString().slice(0, 10)`.**
The latter gives the UTC date, which in India is yesterday until 05:30 every
morning. The reports had this bug twice; the invoice date had it too.

**pdf.js must be `import()`ed, not `require()`d.** It ships as an ES module
only. The system's Node 22 will `require()` one, so `npm run test:extract`
passed, while the Node 20 inside Electron 33 will not — every certificate
upload in the real app threw. `extract.js` uses a dynamic `import()` for
exactly this reason; do not "simplify" it back.

`useSystemFonts` must stay `false` in `extract.js`. With it on, pdf.js finds no
system fonts and renders every page blank white — no error, no warning, just an
empty image that OCR reads as zero characters. `tests/extract.test.js` guards
against this by asserting the rendered PNG is over 100 KB.

## Invoice numbering

    SH/2627/09/0001
    │  │    │  └── counter, restarts at 0001 every month
    │  │    └───── calendar month
    │  └────────── financial year (2026-27)
    └───────────── series prefix, first two letters of the trade name

Fifteen characters, inside the sixteen Rule 46(b) allows, with room for a
three-letter prefix. The counter is owned by financial year *and* month
(`invoice_counters.period_key`, e.g. `2627-09`), so it restarts monthly —
legal as a multiple series, but it does mean a number is only unique when
read together with its month.

The prefix follows the trade name until someone types their own, after which
it stays put. `gst.js` owns both the format and the length check; the setup
and settings screens ask the main process for a sample rather than rebuilding
the string themselves, so the sixteen-character rule lives in one place.

Three letters is the ceiling — `SH1/2627/09/0001` is exactly sixteen — so the
prefix inputs are capped at three rather than letting someone type a fourth
and only find out on save.

## Items, sets and GST rates

A hot plate bills exactly like a service line — description, amount, GST rate,
quantity — so products live in the same `charges` table under `kind`, which
only decides which group they appear under. Everything that applies to a
charge (versioning, confirmation, revision) applies to a product unchanged.

A **set** is a group of items billed together; picking one on the billing
screen adds them all. Sets store the item **description**, not its id, because
revising a rate writes a brand new charge row with a new id — an id reference
would go stale the first time anyone changed a price. Anything a set names that
no longer matches an active charge comes back as `missing` and is reported
rather than silently dropped.

`New connection` is seeded, but neither inspection charge is in it: which one
applies depends on whether the connection is PMUY, and that is not a call this
app should make. Edit the set to match how the territory actually bills.

**GST rate is per item, and the tax follows it.** The screen's totals panel
shows one CGST/SGST row per rate; the printed invoice carries the tax in the
line columns instead (see Printing). Either way an 18% hose and a 28% hot
plate on one invoice are taxed at their own rates and shown that way — the
old literal `CGST @ 9%` text would have printed the wrong rate on a tax
document the moment anything was not 18%.

## Prices with GST inside them

The OMC circular lists each charge three ways — before GST, the GST, and the
amount including GST (Rs 50 + Rs 9 = Rs 59 for the DGCC charge) — and a
product has an MRP. Distributors bill the inclusive figure. So every item
has an **Amount includes GST** switch: when it is on, the basic value is
backed out as price ÷ (1 + rate) and the tax is the remainder, so the line
total lands on the quoted price to the paisa (Rs 190 at 18% → 161.02 +
28.98). The seeded charges are the circular's *before-GST* figures with the
switch off; either way prints the same invoice.

## Deposits

A refundable security deposit — cylinder, regulator, DBTL advance — is not
a supply. It is neither taxable nor exempt; it is simply outside GST. Items
of kind `deposit` print on the invoice and add to the total, but stay out of
the taxable value, carry no tax, take no share of a discount, and are
skipped by every report sheet. A 0% "charge" would have done none of that
correctly — it would have gone into B2CS as nil-rated.

## HSN and SAC codes

Each item has an optional code that prints in an **HSN/SAC** column.
Four-digit HSN is enough at turnover under 5 crore. The charges page keeps
a short reference list (`seed.js`'s `CODE_HINTS`) and offers it as
autocomplete; the seeded service charges carry the SAC codes LPG
distributors commonly use — 998739 installation, 998729 hotplate
inspection and servicing (repair of other goods), 998599 documentation and
administrative charges. Products: 4009 hose, 7321 hot plate, 8481
regulator, 9613 lighter. All are 18% after the September 2025 slab change.
Migration v7 writes these onto seeded charges that had none; anything the
distributor typed is left alone — those show a **No HSN/SAC** badge on the
charges page, and the revise form suggests a code from the description as
a placeholder (hose → 4009, hot plate → 7321) that still has to be accepted.
A line saved before its item had a code borrows the item's current code
when printed (`LINES_SQL` in `repository.js`): a code is a classification,
not a price, so this is safe where borrowing a rate would not be.

A distributor record with no `logo_path` (set up before the picker existed)
prints the bundled Bharatgas mark; `distributor:get` fills it in.

## Discount

The billing screen takes one invoice-level discount in rupees. It is applied
to the value **before tax** and pushed down into each line in proportion to
the line's gross value (`gst.apportionDiscount`, last line takes the paise
remainder so the shares always add up exactly), and tax is then computed on
the discounted taxable value. That order is not a preference: Section 15(3)
only excludes a discount from taxable value when it is recorded on the invoice
against the supply. A discount knocked off the grand total *after* tax would
leave the agency paying GST on money it never collected.

Storage keeps `invoice_lines.line_total` meaning "taxable value of the line",
which is what every report already reads, so the reports needed no change.
The discount is stored beside it — `invoices.discount` as typed, and
`invoice_lines.discount` as each line's share — so gross can be rebuilt for
the print. Migration v6 adds both columns with a default of zero.

## Editing and deleting invoices

The distributor asked for delete rather than cancel, so a wrong invoice can
be removed outright from the Invoices page and it then appears in no report.
Two rules keep that from damaging the series:

**The counter follows the records.** `recomputeCounter` sets a month's next
number to one past the highest number still on file for that month. Delete
the latest invoice and the next one takes its number, so "delete and redo"
leaves no gap. Delete every test invoice before go-live and the month
restarts at 0001 — there is no reset button because none is needed, and the
installer never carries a database in the first place. Delete one from the
middle and the later numbers stay as they are (they are on printed paper);
that gap remains, and the CA should hear about it.

**Edit is delete-and-reinsert in one transaction.** The billing screen opens
with `?edit=<id>`, loads the invoice into the form, and on save calls
`replaceInvoice`, which removes the old row and inserts the corrected one
together — a failure leaves the original untouched. The date is kept; the
number is kept when the invoice was the latest of its month and is otherwise
the next free one, never a number already in use. An invoice referenced by a
credit note refuses to be deleted.

Reprints use `printable.js`, the same renderer the billing screen uses right
after save, so a reprint is the identical document rather than a second
template drifting from the first.

## More than one machine at an agency

Each install keeps its own database and its own counter, and `invoice_no` is
only UNIQUE *within* a database. Two machines sharing a series prefix will
therefore both issue `SH/2627/09/0001` to different customers, and neither
will notice.

**Give every machine its own prefix** — `SH` on one, `SB` on the next. Rule
46(b) allows multiple series. Both setup and settings say so on screen.

Reports read the local database only, so a return filed from one machine
covers that machine alone. The reports screen takes other machines' database
files (their backup copy is fine — they are opened read-only and never
migrated) and merges everything into one workbook. The register gains a
**Machine** column, and any invoice number found on two machines lands on a
**DUPLICATE NUMBERS** sheet placed first in the workbook, so it cannot be
filed past unnoticed.

Do **not** point two installs at one database file on a network share or in a
synced Drive/OneDrive folder. SQLite's locking is unreliable over SMB, and
sync clients copy the file mid-write and produce conflicted copies. Backing
*up* to Drive is fine; running the live database there is not.

## Still to build

Credit notes UI — the table and report sheet exist, the screen does not.
