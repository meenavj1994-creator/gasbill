'use strict';

/* Amounts are the circular's figures before GST (the circular lists Rs 50 +
   Rs 9 GST = Rs 59 for the DGCC charge, for instance). SAC codes are the
   ones LPG distributors commonly use — installation under 998739, hotplate
   inspection and servicing under 998729 (repair of other goods), and
   documentation under 998599 (other support services). Seeded with
   needs_confirmation on, so the CA sees them before they print. */
const SEED = [
  { description: 'Mandatory inspection of domestic installation — PMUY', base_amount: 50, hsn_sac: '998729' },
  { description: 'Visit and administrative charges for release of new connection', base_amount: 100, hsn_sac: '998599' },
  { description: 'Installation and demonstration charges for new connection', base_amount: 100, hsn_sac: '998739' },
  { description: 'Administrative charges for issuance of DGCC', base_amount: 50, hsn_sac: '998599' },
  { description: 'Collection of equipment for termination voucher', base_amount: 100, hsn_sac: '998599' },
  { description: 'Mechanic visit charges (other than leakage)', base_amount: 200, hsn_sac: '998729' },
  { description: 'Mandatory inspection of domestic installation — other consumers', base_amount: 200, hsn_sac: '998729' }
];

/* Reference list shown on the charges page. HSN at four digits is enough
   for turnover under 5 crore; six is fine too. All 18% after the September
   2025 slab change. */
const CODE_HINTS = [
  { code: '4009', label: 'Suraksha hose / rubber tube (HSN)' },
  { code: '7321', label: 'Hot plate / gas stove, 2 or 3 burner (HSN)' },
  { code: '8481', label: 'Pressure regulator (HSN)' },
  { code: '9613', label: 'Gas lighter (HSN)' },
  { code: '4820', label: 'DGCC book, registers (HSN)' },
  { code: '998739', label: 'Installation & demonstration (SAC)' },
  { code: '998729', label: 'Mechanic visit, inspection, hotplate servicing (SAC)' },
  { code: '998599', label: 'Documentation / administrative charges (SAC)' }
];

/* A starting point, not a ruling. Which inspection charge applies depends on
   whether the connection is PMUY, so neither is in here — the distributor adds
   the right one and edits the set to match how their territory actually bills. */
const SEED_SETS = [
  {
    name: 'New connection',
    items: [
      'Visit and administrative charges for release of new connection',
      'Installation and demonstration charges for new connection',
      'Administrative charges for issuance of DGCC'
    ]
  }
];

function seedCharges(repo) {
  if (repo.allCharges().length > 0) return { seeded: 0 };
  let n = 0;
  for (const row of SEED) {
    repo.addCharge({
      description: row.description,
      base_amount: row.base_amount,
      gst_rate: 18,
      hsn_sac: row.hsn_sac || null,
      effective_from: '2019-09-01',
      needs_confirmation: 1
    });
    n++;
  }
  return { seeded: n };
}

function seedBundles(repo) {
  if (repo.listBundles().length > 0) return { seeded: 0 };
  let n = 0;
  for (const set of SEED_SETS) {
    repo.saveBundle({
      name: set.name,
      items: set.items.map(function (description) {
        return { description: description, qty: 1 };
      })
    });
    n++;
  }
  return { seeded: n };
}

module.exports = { seedCharges, seedBundles, SEED, SEED_SETS, CODE_HINTS };
