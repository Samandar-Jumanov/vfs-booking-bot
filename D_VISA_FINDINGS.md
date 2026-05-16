# VFS D-Visa URL Findings

Scope: static source-code inspection only. No browser was opened and no live HTTP requests were made.

## Findings

1. The repository contains two slot URL patterns:
   - `backend/src/modules/monitor/monitor.service.ts` has `buildAvailabilityUrl(source, dest)` returning `https://visa.vfsglobal.com/${source}/en/${dest}/schedule-appointment/get-slots`, but this helper is not used by the active poll path.
   - `backend/src/modules/monitor/playwright.fetch.ts` documents and uses `POST https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable`.

2. In the active `fetchSlotsViaBrowser` path, the visa category is not passed as a path segment or query parameter. It is passed in the POST JSON body as `visaCategoryCode`, alongside `countryCode`, `missionCode`, `vacCode`, `roleName`, `loginUser`, and `payCode`.

3. The booking pages in `session.warmer.ts`, `playwright.fetch.ts`, and `engine.service.ts` all navigate to the same page shape: `https://visa.vfsglobal.com/${source}/en/${dest}/schedule-appointment`. The source code does not show separate schedule-appointment paths for D-visa subtypes.

4. The source code does not contain confirmed category IDs or URL differences for Latvia "Cargo Driver" versus "Work". Based on static code only, they appear to use the same `uzb/en/lva/schedule-appointment` page and the same `CheckIsSlotAvailable` endpoint, with different `visaCategoryCode` values in the POST body.

## Unknowns

- The exact Cargo Driver and Work category codes for `uzb/en/lva` cannot be determined from static analysis alone.
- Whether VFS currently accepts those D-visa categories through the same live flow needs live VFS inspection.

Conclusion: needs live VFS inspection.
