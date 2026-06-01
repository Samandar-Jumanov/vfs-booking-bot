# VFS Lift-API Availability/Slot Endpoint Specification

**Last Updated:** 2026-06-02  
**Status:** Derived from production code inspection (extension + backend polling implementation)

---

## Executive Summary

This document specifies the exact HTTP endpoint, headers, and request/response shapes for polling VFS appointment slot availability **without** driving the booking UI. The lift-api endpoint can be called directly using captured authentication headers to detect available slots in ~1 second per poll — much cheaper than the browser-based polling currently used in `auto_pipeline.py`.

---

## Endpoint URL & Method

**URL:**  
```
https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable
```

**HTTP Method:** `POST`

**Base URL Constant Locations:**
- Extension: `extension/content/vfs-bridge.ts:12`
- Backend: `backend/src/modules/monitor/playwright.fetch.ts:315`

---

## Required Headers

### Authentication Headers (Custom)

These **MUST** be captured from a real VFS lift-api request after the operator logs in:

| Header | Source | Notes |
|--------|--------|-------|
| `authorize` | Service-worker network capture | Custom auth header; NOT the standard `Authorization` header. Contains a token string that VFS validates per-request. **REQUIRED.** |
| `clientsource` | Service-worker network capture | Client identifier; also custom. **REQUIRED.** |

**Capture Location:**  
- Service Worker: `extension/background/service-worker.ts:74-97`
- Storage: Persisted to `chrome.storage.local.liftAuthHeaders` (dict of all request headers)
- Content Script Bridge: `extension/content/vfs-bridge.ts:54-62`

### Standard Headers (Always Send)

| Header | Value | Notes |
|--------|-------|-------|
| `Content-Type` | `application/json;charset=UTF-8` | JSON request body |
| `Accept` | `application/json, text/plain, */*` | Accept JSON response |

**Optional (Recommended for Browser Mimicry):**
| Header | Typical Value | Notes |
|--------|---|---|
| `Origin` | `https://visa.vfsglobal.com` | Cloudflare WAF sometimes checks this |
| `Referer` | `https://visa.vfsglobal.com/{sourceCode}/en/{destCode}/schedule-appointment` | Complete WAF mimicry |
| `User-Agent` | Chrome 134+ on Windows | See backend `UA` constant |

**Cookie Header:**  
Cookies can be passed as a `Cookie` header (when polling via proxy) OR omitted if credentials are included in cookies context (CDP mode).

---

## Request Body Shape

**Type Reference:** `backend/src/modules/monitor/playwright.fetch.ts:317-325`

```typescript
interface SlotCheckRequest {
  countryCode: string;       // Source country code: 'uzb', 'tjk', etc.
  missionCode: string;       // Destination country code: 'lva', 'prt', 'bra', etc.
  vacCode: string;           // Centre/VAC code: 'TAS' (Tashkent), 'SKD', 'BUK', etc.
  visaCategoryCode: string;  // Category code: 'LSHRSDTJK', 'WDVUZ', etc.
  roleName: string;          // 'Individual' (fixed for personal bookings)
  loginUser: string;         // User's email (empty string allowed, but include for tracking)
  payCode: string;           // Empty string (always '')
}
```

### Field Mapping to Work-D-visa

**`visaCategoryCode`** identifies the visa type. Capture it from the booking wizard:
- **Work D-visa:** code like `WDVUZ` or `LSHRSDTJK` (depends on destination)
- Source: Service-worker extracts from VFS's own `CheckIsSlotAvailable` request body

**`vacCode`** identifies the VFS centre:
- **Tashkent (default):** `TAS`
- **Samarkand:** `SKD`
- **Bukhara:** `BUK`
- Others: Captured during wizard navigation

**`countryCode` → sourceCountry mapping:**
| Name | Code |
|------|------|
| Uzbekistan | `uzb` |
| Tajikistan | `tjk` |
| Turkmenistan | `tkm` |

**`missionCode` → destination mapping:**
| Name | Code |
|------|------|
| Latvia | `lva` |
| Portugal | `prt` |
| Brazil | `bra` |

---

## Response Shape

**Type Reference:** `backend/src/modules/monitor/playwright.fetch.ts:327-331`

```typescript
interface SlotCheckResponse {
  earliestDate: string | null;           // YYYY-MM-DD or null if no slots
  earliestSlotLists: Array<{
    applicant: string;                   // Name/identifier
    date: string;                        // YYYY-MM-DD
  }>;
  error: {
    code: number;
    description: string;
    type: string;
  } | null;                              // null if success, populated on error
}
```

### Interpreting Responses

**Success (HTTP 200, slots available):**
```json
{
  "earliestDate": "2026-06-15",
  "earliestSlotLists": [
    { "applicant": "Primary", "date": "2026-06-15" }
  ],
  "error": null
}
```
Slots are available starting 2026-06-15

**Success (HTTP 200, no slots):**
```json
{
  "earliestDate": null,
  "earliestSlotLists": [],
  "error": null
}
```
No slots currently available

**Authentication Failure (HTTP 401/402):**
```json
{
  "error": {
    "code": 401,
    "description": "Unauthorized",
    "type": "AUTH_ERROR"
  }
}
```
Captured headers are invalid or expired. Refresh via login.

**Rate Limited (HTTP 429):**
```json
{
  "error": {
    "code": 429,
    "description": "Too many requests",
    "type": "RATE_LIMIT"
  }
}
```
Back off exponentially. Min ceiling: 60 seconds.

**Bot/IP Blocked (HTTP 403):**
```json
{
  "error": {
    "code": 403,
    "description": "Access Denied",
    "type": "VFS_BOT_DETECTED"
  }
}
```
VFS datadome/WAF blocked the IP. Cool down 10 minutes and retry via proxy (BrightData recommended).

---

## How to Capture Auth Headers

### Method 1: Browser Extension (Recommended for Operator)

1. Operator logs into VFS at `https://visa.vfsglobal.com/uzb/en/lva/login`
2. Navigates to the booking wizard → selects centre + visa category
3. Extension service-worker automatically captures `authorize` + `clientsource` from the first lift-api request
4. Headers are persisted to `chrome.storage.local.liftAuthHeaders`
5. Backend polls headers via `/api/accounts/inject-cookies` endpoint (sync-on-login or manual)

**Code Path:**
- Capture: `extension/background/service-worker.ts:74-97`
- Storage: `liftAuthHeaders` (dict)
- Replay (extension): `extension/content/vfs-bridge.ts:945-969`
- Sync to backend: `extension/background/service-worker.ts:1025-1082`

### Method 2: Network Inspector (Dev for Testing)

1. Open DevTools on VFS booking page → Network tab
2. Trigger a slot check (click Continue after selecting a visa category)
3. Filter requests to `lift-api.vfsglobal.com`
4. Find `CheckIsSlotAvailable` POST request → Request Headers tab
5. Copy `authorize` and `clientsource` header values

### Method 3: Cold IP Capture (Production)

For production polling with fresh IPs (to bypass rate limits):
1. Use a BrightData UZ residential proxy
2. Maintain a fresh operator VFS session (via extension + keep-alive)
3. Let the backend's `monitor.service.ts` auto-capture and rotate session keys

**Rotation Code:** `backend/src/modules/monitor/monitor.service.ts:340-344`

---

## Full Example Request (Python)

```python
import json
import requests
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter

# 1. Captured auth headers from VFS login
auth_headers = {
    "authorize": "Bearer eyJ0eXAiOiJKV1QiLCJhbGc...",  # CAPTURED FROM VFS
    "clientsource": "web_app_v2",                        # CAPTURED FROM VFS
}

# 2. Request body
body = {
    "countryCode": "uzb",
    "missionCode": "lva",
    "vacCode": "TAS",
    "visaCategoryCode": "WDVUZ",
    "roleName": "Individual",
    "loginUser": "operator@example.com",
    "payCode": ""
}

# 3. Standard headers for WAF mimicry
headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://visa.vfsglobal.com",
    "Referer": "https://visa.vfsglobal.com/uzb/en/lva/schedule-appointment",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}
headers.update(auth_headers)

# 4. Send request (example with retries)
session = requests.Session()
retry = Retry(total=3, backoff_factor=1)
session.mount("https://", HTTPAdapter(max_retries=retry))

response = session.post(
    "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable",
    json=body,
    headers=headers,
    timeout=30,
)

# 5. Parse response
if response.status_code == 200:
    data = response.json()
    if data.get("earliestDate"):
        print(f"SLOTS FOUND: {data['earliestDate']}")
    else:
        print("No slots available")
elif response.status_code == 429:
    print("Rate limited — back off 60+ seconds")
elif response.status_code == 403:
    print("IP blocked — use proxy or cool down 10 minutes")
else:
    print(f"HTTP {response.status_code}: {response.text}")
```

---

## Security Notes

- **Never commit captured tokens** to version control
- Store tokens in environment variables or secure storage only
- **Rotate tokens** after each login (20-30 minute window recommended)
- Consider using **BrightData UZ proxy** to mask polling from Datadome (IP rotation every 30s)
- **Rate-limit aggressively:** 1 poll/minute per account to avoid cascading 429s

---

## What Is KNOWN From Code

✅ Endpoint URL  
✅ HTTP method (POST)  
✅ Custom header names (`authorize`, `clientsource`)  
✅ Request body shape & field names  
✅ Response JSON structure  
✅ HTTP status code semantics (200=success, 401/402=auth fail, 429=rate-limited, 403=IP blocked)  
✅ Field mappings (vacCode → centre, visaCategoryCode → visa type, countryCode → country)  
✅ Rate limit floor (1 poll/min, exponential backoff)  
✅ Header capture mechanism (service-worker's chrome.webRequest.onBeforeSendHeaders)  

---

## What REQUIRES A LIVE CAPTURE

❓ **Exact header token format & lifetime**  
The `authorize` header appears to be a JWT or opaque token; exact format unknown. VFS may validate token signature or check issue-time; expiry unknown (suspected ~24h).

❓ **Full list of optional request fields**  
Current spec covers the known fields; VFS may accept others (e.g., `timezone`, `language`).

❓ **Exact error codes & descriptions for edge cases**  
402 vs 401 distinction, exact Datadome response format, etc.

❓ **Cookie dependency**  
Does the endpoint require both cookies AND `authorize` header, or just one? Can a fresh session use only the header?

❓ **Applicant field in response**  
Currently `{ applicant: string; date: string }` — applicant value unknown.

---

## Recommended Polling Implementation

### Option A: Python in auto_pipeline.py (Lightweight, Fast)

**Pros:**
- Single-threaded async I/O (no browser overhead)
- Can poll every 10-30 seconds (no WAF timeouts)
- Easy to instrument & log

**Cons:**
- Must handle auth header refresh manually
- Datadome may block plain axios/urllib (though less likely than selenium)

### Option B: Node.js Module (Reuse in Extension or Backend)

**Pros:**
- Can be shared with backend/frontend
- TypeScript type-safe
- Integrates with existing monitoring stack

**Cons:**
- More code to maintain
- Add axios/node-fetch dependency

---

## References

| File | Purpose |
|------|---------|
| `extension/background/service-worker.ts:74–97` | Auth header capture |
| `extension/content/vfs-bridge.ts:928–969` | Live polling impl (extension) |
| `backend/src/modules/monitor/playwright.fetch.ts:315–434` | Live polling impl (backend) |
| `backend/src/modules/monitor/monitor.service.ts:930–1153` | Polling loop + backoff logic |
| `nodriver-spike/auto_pipeline.py:407–466` | UI-based slot detection (for reference) |

---

## Future Work

1. **Measure real token TTL** — empirically test how long `authorize` tokens remain valid
2. **Datadome fingerprint study** — test if plain axios POSTs get flagged; collect failure patterns
3. **Applicant field interpretation** — capture & decode the response to understand what "applicant" represents
4. **Multi-destination polling** — test if same token works for different routes (uzb→lva, ujk→prt, etc.)
5. **Batch check endpoint** — investigate if VFS exposes a multi-category check endpoint

