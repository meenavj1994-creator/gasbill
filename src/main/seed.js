'use strict';

const SEED = [
  { description: 'Mandatory inspection of domestic installation — PMUY', base_amount: 50 },
  { description: 'Visit and administrative charges for release of new connection', base_amount: 100 },
  { description: 'Installation and demonstration charges for new connection', base_amount: 100 },
  { description: 'Administrative charges for issuance of DGCC', base_amount: 50 },
  { description: 'Collection of equipment for termination voucher', base_amount: 100 },
  { description: 'Mechanic visit charges (other than leakage)', base_amount: 200 },
  { description: 'Mandatory inspection of domestic installation — other consumers', base_amount: 200 }
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

module.exports = { seedCharges, seedBundles, SEED, SEED_SETS };
