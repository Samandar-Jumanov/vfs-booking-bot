Title: feat(scraping): TRACK 8 - ScraperAPI provider fallback

## Summary

- Adds ScraperAPI env config and `.env.example` documentation.
- Adds `fetchViaScraperApi` REST adapter with premium/country/header/cookie support and an in-process hourly request guard.
- Routes slot polling through ScraperAPI when `SCRAPER_API` is set and `BRIGHTDATA_WS` is empty; BrightData still has priority when both are set.
- Logs active monitor provider mode as `local`, `brightdata`, or `scraperapi`.
- Adds `backend/scripts/test-scraperapi.ts` smoke test for VFS page GET and slot-shaped POST.

## Verification

```text
backend> npm.cmd run build

> backend@1.0.0 build
> tsc --project tsconfig.json && tsc-alias -p tsconfig.json
```

```text
backend> npm.cmd test

> backend@1.0.0 test
> jest --runInBand

PASS src/modules/__tests__/integration.test.ts
PASS src/utils/retry.test.ts
PASS src/utils/crypto.test.ts
PASS src/modules/profiles/profiles.schema.test.ts
PASS src/modules/proxy/proxy.service.test.ts
PASS src/modules/monitor/monitor.service.test.ts
PASS src/modules/captcha/captcha.service.test.ts

Test Suites: 7 passed, 7 total
Tests:       62 passed, 62 total
Snapshots:   0 total
```

```text
backend> npx.cmd ts-node scripts/test-scraperapi.ts
connect EACCES 159.203.159.103:443
```

Smoke test note: the script starts correctly, loads config, and reaches the outbound HTTPS connection, but this Codex environment blocks the connection with `EACCES`. A successful VFS fetch output still needs to be collected from an environment with outbound access to ScraperAPI.

## Cost Estimate

Sources checked 2026-05-15:

- ScraperAPI credit docs: https://docs.scraperapi.com/getting-started/quick-start/credits-and-requests-costs
- ScraperAPI pricing: https://www.scraperapi.com/pricing/

Current implementation uses `premium=true`, `country_code=uz`, and `keep_headers=true`; slot polls do not use JS rendering. ScraperAPI docs list `premium=true` at 10 API credits/request, while bot-protected bypasses such as Cloudflare/Datadome/Turnstile are also listed at 10 credits/scrape. Practical estimate for VFS slot polling is therefore 10 to 20 credits per successful poll depending on whether ScraperAPI classifies the target as requiring bot-protection bypass.

Plan-based rough costs:

- Hobby: $49 / 100,000 credits = $0.00049 per credit, about $0.0049 to $0.0098 per poll.
- Startup: $149 / 1,000,000 credits = $0.000149 per credit, about $0.00149 to $0.00298 per poll.
- Business: $299 / 3,000,000 credits = about $0.0000997 per credit, about $0.0010 to $0.0020 per poll.

The added default guard caps usage at `SCRAPER_API_MAX_REQUESTS_PER_HOUR=200`. At the 10 to 20 credit estimate, that caps hourly burn at about 2,000 to 4,000 credits/hour before the process throws and stops polling through ScraperAPI.

## Notes

- No commits or pushes were made.
- No git staging was performed.
- Pre-existing dirty working tree files were left untouched.
