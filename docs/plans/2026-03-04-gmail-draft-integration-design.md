# Gmail Draft Integration Design

## Problem
After generating an invoice filename and downloading the renamed PDF, the user still has to manually open Gmail, compose an email, type/paste the subject, write the body, attach the PDF, and look up the recipient. This is repetitive — the template is nearly identical every time.

## Solution
Add a "Draft Invoice Email" button that creates a Gmail draft with the subject, body template, PDF attachment, and best-guess recipient pre-filled. The user reviews and sends from Gmail.

## Architecture

### Worker Additions (`worker/src/index.js`)

**Google OAuth flow** — mirrors the existing Xero OAuth pattern:
- `GET /gmail/auth` — redirects to Google OAuth consent screen
- `GET /gmail/callback` — exchanges code for tokens, stores in KV
- Scopes: `gmail.compose` (create drafts), `gmail.readonly` (search sent mail for recipient lookup)
- Tokens stored in same KV namespace as Xero tokens, prefixed with `gmail_`

**Draft creation endpoint**:
- `POST /gmail/draft` — accepts `{ invoiceId, subject, hiringEntity }`
- Fetches the invoice PDF from Xero (reuses existing `getValidToken`/Xero API logic)
- Searches Gmail sent mail for `from:me subject:"Invoice for Labor" "{hiringEntity}"` to find last recipient
- Constructs a multipart MIME message with:
  - To: last known recipient (or empty)
  - Subject: the generated email subject
  - Body: hardcoded template
  - Attachment: the renamed PDF
- Creates draft via `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts`
- Returns `{ draftId, draftUrl }` — URL opens Gmail to that draft

### Frontend Additions (`filename_generator.html`)

- "Connect Gmail" button below the existing "Load Xero Invoices" button, same dashed-border style
- "Draft Invoice Email" button in the output card, shown only when Gmail is connected AND a Xero invoice is selected
- On click: POST to `/gmail/draft`, then open the returned Gmail draft URL in a new tab
- Loading state on the button while the draft is being created

### Email Template (hardcoded)
```
Good Morning!

I've attached my invoice for this one. Let me know if there's any issues in processing.

Thanks!

Eric
```

### Recipient Lookup Strategy
- Search Gmail sent folder: `from:me subject:"Invoice for Labor" "{hiringEntity}"`
- Use the `To` header from the most recent match
- If no match found, leave the To field empty — user fills it in manually
- No database needed — learns from actual email history

## Google Cloud Setup Required
- Google Cloud project with Gmail API enabled
- OAuth 2.0 credentials (Web application type)
- Authorized redirect URI: `https://xero-invoice-proxy.edweiss412.workers.dev/gmail/callback`
- Cloudflare Worker secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## CORS
Existing CORS setup applies — the frontend already talks to the worker. The new endpoints follow the same pattern.

## Token Storage (KV)
- `gmail_access_token` (TTL: 3600s — Google tokens last 1 hour)
- `gmail_refresh_token` (no TTL)
