# Worker Auth: Password Login with 30-Day Session Cookie

## Problem

The Cloudflare Worker endpoints are publicly accessible. Anyone who finds the worker URL (visible in GitHub Pages source) can access Xero invoices and Gmail drafts.

## Solution

Password-based login that sets a signed session cookie valid for 30 days.

## Login Flow

1. Any request without a valid session cookie returns 401 (except `/login`, CORS preflight, and OAuth callbacks)
2. `POST /login` validates `{ password }` against `AUTH_PASSWORD` worker secret
3. On success, sets an `HttpOnly; Secure; SameSite=None` cookie with HMAC-signed token
4. Subsequent requests: worker verifies cookie signature and expiry before processing

## Session Token Format

```
session=<expiry_hex>.<hmac_sha256_hex>
```

- Expiry: current time + 30 days, hex-encoded
- HMAC: SHA-256 signature of the expiry using `AUTH_SECRET` worker secret
- Verification: recompute HMAC, compare, check expiry > now

## Cookie Attributes

- `HttpOnly` — not accessible to JS
- `Secure` — HTTPS only
- `SameSite=None` — required for cross-origin (github.io → workers.dev)
- `Max-Age=2592000` — 30 days
- `Path=/`

## Unprotected Routes

- `OPTIONS` — CORS preflight
- `POST /login` — login endpoint
- `/callback` — Xero OAuth redirect
- `/gmail/callback` — Gmail OAuth redirect

## Worker Secrets

- `AUTH_PASSWORD` — user's chosen password
- `AUTH_SECRET` — random key for HMAC signing

## Frontend Changes

- On 401 from any fetch, show a login modal (password + submit)
- After successful login, retry auto-load (invoices + Gmail status)
- No password stored client-side; cookie handles session persistence
