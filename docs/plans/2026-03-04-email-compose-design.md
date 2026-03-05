# In-App Email Compose & Schedule Send

## Problem

Tapping "Draft Invoice Email" creates a Gmail draft and tries to open it — but on mobile (Android), the Gmail app can't be deep-linked to a specific draft. The web URL opens in Chrome instead. Additionally, sending the same templated email repeatedly feels robotic.

## Solution

Replace the draft-and-open flow with a full in-app compose sheet. Users review, edit, and send/schedule emails entirely within the app. No Gmail app dependency.

## UI: Compose Sheet

Slides up (same pattern as booking-sheet/output-sheet) when user taps "Draft Invoice Email" in the output sheet. Contains:

1. **To** — pre-filled from last email to that contact, editable
2. **Subject** — pre-filled from generated email subject, editable
3. **Body** — editable text area, pre-loaded with a randomly selected message variation (excluding last-used for this contact). Other variations shown as tappable cards below.
4. **Attachment** — read-only line showing PDF filename with paperclip icon
5. **Schedule bar** — defaults to 8:00 AM client local time on invoice issue date. Tap to change date/time/timezone.
6. **Actions** — "Send Now" and "Schedule Send" buttons

## Message Variations

4 static pre-written variations stored in the frontend:

1. "Good morning! I've attached my invoice for this one. Let me know if there are any issues in processing. Thanks!"
2. "Hi there — invoice is attached for your review. Please don't hesitate to reach out with any questions. Thank you!"
3. "Morning! Attached is my invoice for this booking. Feel free to reach out if anything needs adjusting. Thanks so much!"
4. "Hi! Invoice attached for this one. Let me know if you need anything else from my end. Thanks!"

- One randomly selected (excluding last-used for this contact) and loaded into text area
- Other 3 shown as tappable cards to swap
- User can freely edit after selecting
- Sign-off name ("Eric") appended automatically
- Last-used variation index tracked per contact in Cloudflare KV

## Schedule Send

- Gmail API supports `X-Gm-Send-At` header with Unix timestamp for delayed delivery
- No cron jobs or Durable Objects needed
- Default: 8:00 AM in client's local timezone on invoice issue date
- Client timezone derived from Xero contact address (country/region → timezone lookup table)
- Fallback: America/Chicago
- If scheduled time is in the past, default to "Send Now"
- UI: schedule bar shows date, time, and timezone label (ET/CT/MT/PT). Each tappable to adjust.

## Worker Architecture

### New Endpoints

**`POST /gmail/send`**
- Receives: `{ invoiceId, subject, body, hiringEntity, filename, scheduledAt? }`
- Reuses existing logic: fetch tokens, download PDF from Xero, build MIME
- Uses request `body` instead of hardcoded template
- Sends via `gmail/v1/users/me/messages/send` with `X-Gm-Send-At` if scheduled
- Returns: `{ messageId, scheduled: true/false }`

**`GET /gmail/recipient?invoiceId=...`**
- Searches Gmail for last email to Xero contact
- Returns: `{ email, contactId }`

**`GET /xero/contact-timezone?contactId=...`**
- Fetches contact address from Xero API
- Maps region/country to timezone via lookup table
- Returns: `{ timezone: "America/Chicago", label: "CT" }`

**`PUT/GET /variation/:contactId`**
- Stores/retrieves last-used variation index in KV

**Removed:** `/gmail/draft` endpoint (no longer needed)

## Data Flow

1. **User taps "Draft Invoice Email"** → compose sheet opens
2. **Parallel requests:** fetch recipient, contact timezone, last variation index
3. **Compose sheet populates:** To, Subject, Body (with variation), Schedule bar
4. **User reviews/edits** as needed
5. **User taps "Send Now" or "Schedule Send":**
   - `POST /gmail/send` with all fields
   - `PUT /variation/:contactId` with selected index
   - Worker downloads PDF, builds MIME, sends via Gmail API
   - Compose sheet closes, toast confirms action

## Error Handling

- Gmail/Xero token expired → reconnect prompt (existing behavior)
- Send fails → error banner in compose sheet, user can retry
- No recipient found → To field empty, user types manually
- Schedule time in past → default to "Send Now"
