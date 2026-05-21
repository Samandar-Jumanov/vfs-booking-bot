import { runE2e, assert } from './common';

runE2e('13. Vendor balance fetching', async () => {
  const { fetchAllBalances } = await import('../../src/modules/vendor/balance.fetcher');
  const balances = await fetchAllBalances();
  const vendors = balances.map((b) => b.vendor).sort();
  for (const vendor of ['2captcha', 'mailsac', 'onlinesim', 'vaksms']) {
    assert(vendors.includes(vendor), `missing vendor balance result for ${vendor}`);
  }
  for (const balance of balances) {
    assert(typeof balance.configured === 'boolean', `vendor ${balance.vendor} missing configured boolean`);
    assert(balance.balanceUsd === null || Number.isFinite(balance.balanceUsd), `vendor ${balance.vendor} returned invalid balance`);
  }
});
