import { runE2e, assert, isDryRun, skip, withTestServer } from './common';

runE2e('13. Vendor balance fetching', async () => {
  const keys = ['TWOCAPTCHA_API_KEY', 'MAILSAC_API_KEY', 'ONLINESIM_API_KEY', 'VAKSMS_API_KEY'] as const;
  const keyToVendor: Record<(typeof keys)[number], string> = {
    TWOCAPTCHA_API_KEY: '2captcha',
    MAILSAC_API_KEY: 'mailsac',
    ONLINESIM_API_KEY: 'onlinesim',
    VAKSMS_API_KEY: 'vaksms',
  };
  const previous = new Map<string, string | undefined>();
  for (const key of keys) previous.set(key, process.env[key]);
  const shouldHitLiveVendors = process.env.E2E_LIVE_VENDOR_BALANCE === '1' && !isDryRun();
  const liveConfiguredVendors = keys.filter((key) => Boolean(process.env[key])).map((key) => keyToVendor[key]);

  try {
    if (shouldHitLiveVendors && liveConfiguredVendors.length === 0) {
      skip('E2E_LIVE_VENDOR_BALANCE=1 set but no vendor API keys are configured');
    }
    if (!shouldHitLiveVendors) {
      for (const key of keys) delete process.env[key];
    }
    await withTestServer(async ({ baseUrl, authHeader }) => {
      const res = await fetch(`${baseUrl}/api/vendor/balance`, { headers: authHeader });
      assert(res.ok, `vendor balance returned HTTP ${res.status}`);
      const body = await res.json() as { balances?: Array<{ vendor: string; configured: boolean; balanceUsd: number | null }> };
      const balances = body.balances ?? [];
      const vendors = balances.map((b) => b.vendor).sort();
      for (const vendor of ['2captcha', 'mailsac', 'onlinesim', 'vaksms']) {
        assert(vendors.includes(vendor), `missing vendor balance result for ${vendor}`);
      }
      for (const balance of balances) {
        assert(typeof balance.configured === 'boolean', `vendor ${balance.vendor} missing configured boolean`);
        assert(balance.balanceUsd === null || Number.isFinite(balance.balanceUsd), `vendor ${balance.vendor} returned invalid balance`);
        if (!shouldHitLiveVendors) {
          assert(balance.configured === false, `vendor ${balance.vendor} should be unconfigured in non-live vendor balance test`);
        } else if (liveConfiguredVendors.includes(balance.vendor)) {
          assert(balance.configured === true, `vendor ${balance.vendor} should be configured in live vendor balance test`);
          assert(balance.balanceUsd !== null, `vendor ${balance.vendor} returned null live balance despite configured API key`);
        }
      }
    });
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
