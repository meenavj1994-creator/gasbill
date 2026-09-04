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

module.exports = { seedCharges, SEED };
