# In-App Email Compose & Schedule Send — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the "create Gmail draft + open browser" flow with an in-app compose sheet that lets users review, edit, and send/schedule invoice emails directly.

**Architecture:** New compose sheet (same slide-up pattern as output-sheet/booking-sheet) overlays the output sheet. Three new worker endpoints handle recipient lookup, contact timezone, and sending. Variation tracking uses Cloudflare KV. Gmail API's native `X-Gm-Send-At` handles scheduling.

**Tech Stack:** Vanilla JS/HTML/CSS (matches existing), Cloudflare Worker, Gmail API, Xero API, Cloudflare KV.

**Design doc:** `docs/plans/2026-03-04-email-compose-design.md`

---

### Task 1: Add `GET /gmail/recipient` endpoint to worker

Extracts the existing `findLastRecipient` logic into a standalone endpoint so the frontend can pre-fill the To field.

**Files:**
- Modify: `worker/src/index.js:12-36` (route table)
- Modify: `worker/src/index.js:478-507` (reuse `findLastRecipient`)

**Step 1: Add route**

In `worker/src/index.js`, add after line 34 (`/gmail/draft` route):

```javascript
if (path === '/gmail/recipient' && request.method === 'GET') return handleGmailRecipient(url, env);
```

**Step 2: Add handler function**

Add after the `handleGmailDraft` function (after line 476):

```javascript
async function handleGmailRecipient(url, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  const invoiceId = url.searchParams.get('invoiceId');
  if (!invoiceId || !/^[a-f0-9-]+$/i.test(invoiceId)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing invoiceId' }), {
      status: 400, headers: jsonHeaders,
    });
  }

  const gmailToken = await getValidGmailToken(env);
  if (!gmailToken) {
    return new Response(JSON.stringify({ error: 'gmail_auth_required' }), {
      status: 401, headers: jsonHeaders,
    });
  }

  // Get contact name from Xero to search Gmail
  const xeroToken = await getValidToken(env);
  if (!xeroToken) {
    return new Response(JSON.stringify({ error: 'xero_auth_required' }), {
      status: 401, headers: jsonHeaders,
    });
  }

  const tenantId = await env.TOKENS.get('tenant_id');
  const invRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
    headers: {
      'Authorization': `Bearer ${xeroToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/json',
    },
  });

  if (!invRes.ok) {
    return new Response(JSON.stringify({ error: 'invoice_fetch_failed' }), {
      status: 500, headers: jsonHeaders,
    });
  }

  const invData = await invRes.json();
  const invoice = invData.Invoices?.[0];
  const contactName = invoice?.Contact?.Name || '';
  const contactId = invoice?.Contact?.ContactID || '';

  const email = await findLastRecipient(gmailToken, contactName);

  return new Response(JSON.stringify({ email: email || '', contactId, contactName }), {
    headers: jsonHeaders,
  });
}
```

**Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add GET /gmail/recipient endpoint"
```

---

### Task 2: Add `GET /xero/contact-timezone` endpoint to worker

Fetches contact address from Xero and maps region/country to a timezone.

**Files:**
- Modify: `worker/src/index.js:12-36` (route table)
- Modify: `worker/src/index.js` (new handler + timezone lookup table)

**Step 1: Add route**

After the gmail/recipient route added in Task 1:

```javascript
if (path === '/xero/contact-timezone' && request.method === 'GET') return handleContactTimezone(url, env);
```

**Step 2: Add timezone lookup table and handler**

Add after `handleGmailRecipient`:

```javascript
const US_STATE_TIMEZONES = {
  // Eastern
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', IN: 'America/Indiana/Indianapolis', KY: 'America/New_York',
  MA: 'America/New_York', MD: 'America/New_York', ME: 'America/New_York',
  MI: 'America/New_York', NC: 'America/New_York', NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VA: 'America/New_York', VT: 'America/New_York', WV: 'America/New_York',
  DC: 'America/New_York',
  // Central
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago',
  IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  WI: 'America/Chicago',
  // Mountain
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise',
  MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver',
  WY: 'America/Denver',
  // Pacific
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  // Other
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

const TZ_LABELS = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'MT',
  'America/Boise': 'MT',
  'America/Indiana/Indianapolis': 'ET',
  'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT',
  'Pacific/Honolulu': 'HT',
};

const DEFAULT_TIMEZONE = 'America/Chicago';
const DEFAULT_TZ_LABEL = 'CT';

async function handleContactTimezone(url, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  const contactId = url.searchParams.get('contactId');
  if (!contactId) {
    return new Response(JSON.stringify({ timezone: DEFAULT_TIMEZONE, label: DEFAULT_TZ_LABEL }), {
      headers: jsonHeaders,
    });
  }

  const xeroToken = await getValidToken(env);
  if (!xeroToken) {
    return new Response(JSON.stringify({ error: 'xero_auth_required' }), {
      status: 401, headers: jsonHeaders,
    });
  }

  const tenantId = await env.TOKENS.get('tenant_id');

  try {
    const res = await fetch(`https://api.xero.com/api.xro/2.0/Contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${xeroToken}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ timezone: DEFAULT_TIMEZONE, label: DEFAULT_TZ_LABEL }), {
        headers: jsonHeaders,
      });
    }

    const data = await res.json();
    const addresses = data.Contacts?.[0]?.Addresses || [];
    // Prefer STREET address, fall back to POBOX
    const addr = addresses.find(a => a.AddressType === 'STREET') || addresses.find(a => a.AddressType === 'POBOX');

    if (addr?.Region) {
      const state = addr.Region.trim().toUpperCase();
      const tz = US_STATE_TIMEZONES[state];
      if (tz) {
        return new Response(JSON.stringify({ timezone: tz, label: TZ_LABELS[tz] || DEFAULT_TZ_LABEL }), {
          headers: jsonHeaders,
        });
      }
    }

    return new Response(JSON.stringify({ timezone: DEFAULT_TIMEZONE, label: DEFAULT_TZ_LABEL }), {
      headers: jsonHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ timezone: DEFAULT_TIMEZONE, label: DEFAULT_TZ_LABEL }), {
      headers: jsonHeaders,
    });
  }
}
```

**Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add GET /xero/contact-timezone endpoint"
```

---

### Task 3: Add variation tracking endpoints to worker

Store and retrieve the last-used message variation index per contact in KV.

**Files:**
- Modify: `worker/src/index.js:12-36` (route table)
- Modify: `worker/src/index.js` (new handlers)

**Step 1: Add routes**

```javascript
const variationMatch = path.match(/^\/variation\/([a-f0-9-]+)$/i);
if (variationMatch && request.method === 'GET') return handleGetVariation(variationMatch[1], env);
if (variationMatch && request.method === 'PUT') return handlePutVariation(variationMatch[1], request, env);
```

**Step 2: Add handlers**

```javascript
async function handleGetVariation(contactId, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const lastIndex = await env.TOKENS.get(`variation:${contactId}`);
  return new Response(JSON.stringify({ lastIndex: lastIndex !== null ? parseInt(lastIndex, 10) : null }), {
    headers: jsonHeaders,
  });
}

async function handlePutVariation(contactId, request, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const { index } = await request.json();
  await env.TOKENS.put(`variation:${contactId}`, String(index));
  return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
}
```

**Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add variation tracking endpoints (GET/PUT /variation/:contactId)"
```

---

### Task 4: Add `POST /gmail/send` endpoint to worker

The core sending endpoint. Reuses existing PDF fetch and MIME building logic. For scheduled sends, creates a draft — Gmail's scheduled send via REST API is not publicly supported, so the worker stores the scheduled time in KV and a cron trigger sends it. For immediate sends, uses `messages/send` directly.

**Note on scheduling approach:** Gmail's `X-Gm-Send-At` header is not available in the public REST API. Two options:
- **Option A (simpler):** Create a Gmail draft and store `{ draftId, sendAt }` in KV. A Cloudflare Cron Trigger (runs every 5 minutes) checks for pending scheduled sends and sends them via `drafts/send`.
- **Option B (simplest MVP):** For now, just create the draft for scheduled sends, show a toast "Draft saved — scheduled sends coming soon", and implement the cron trigger as a follow-up task.

The plan below implements Option A.

**Files:**
- Modify: `worker/src/index.js:12-36` (route table)
- Modify: `worker/src/index.js` (new handler)
- Modify: `worker/wrangler.toml` (add cron trigger)

**Step 1: Add route**

```javascript
if (path === '/gmail/send' && request.method === 'POST') return handleGmailSend(request, env);
```

**Step 2: Add handler**

```javascript
async function handleGmailSend(request, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  try {
    const { invoiceId, to, subject, body, filename, scheduledAt } = await request.json();

    if (!invoiceId || !to || !subject || !body || !filename) {
      return new Response(JSON.stringify({ error: 'Missing required fields: invoiceId, to, subject, body, filename' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    if (!/^[a-f0-9-]+$/i.test(invoiceId)) {
      return new Response(JSON.stringify({ error: 'Invalid invoiceId' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    const gmailToken = await getValidGmailToken(env);
    if (!gmailToken) {
      return new Response(JSON.stringify({ error: 'gmail_auth_required' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const xeroToken = await getValidToken(env);
    if (!xeroToken) {
      return new Response(JSON.stringify({ error: 'xero_auth_required' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    // Fetch invoice PDF from Xero
    const tenantId = await env.TOKENS.get('tenant_id');
    const pdfRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      headers: {
        'Authorization': `Bearer ${xeroToken}`,
        'xero-tenant-id': tenantId,
        'Accept': 'application/pdf',
      },
    });

    if (!pdfRes.ok) {
      return new Response(JSON.stringify({ error: 'pdf_fetch_failed', details: await pdfRes.text() }), {
        status: 500, headers: jsonHeaders,
      });
    }

    const pdfBytes = await pdfRes.arrayBuffer();
    const mimeMessage = buildMimeMessage({ to, subject, body, pdfBytes, pdfFilename: filename });
    const rawMessage = base64url(mimeMessage);

    const gmailHeaders = {
      'Authorization': `Bearer ${gmailToken}`,
      'Content-Type': 'application/json',
    };

    // Scheduled send: create draft + store scheduled job in KV
    if (scheduledAt) {
      const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: gmailHeaders,
        body: JSON.stringify({ message: { raw: rawMessage } }),
      });

      if (!draftRes.ok) {
        const err = await draftRes.text();
        return new Response(JSON.stringify({ error: 'draft_creation_failed', details: err }), {
          status: 500, headers: jsonHeaders,
        });
      }

      const draft = await draftRes.json();

      // Store scheduled send job in KV
      const jobId = `scheduled:${draft.id}`;
      await env.TOKENS.put(jobId, JSON.stringify({
        draftId: draft.id,
        sendAt: scheduledAt,
        createdAt: new Date().toISOString(),
      }));

      // Add to scheduled sends index for cron to find
      const indexRaw = await env.TOKENS.get('scheduled_sends_index');
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      index.push(draft.id);
      await env.TOKENS.put('scheduled_sends_index', JSON.stringify(index));

      return new Response(JSON.stringify({ draftId: draft.id, scheduled: true }), {
        headers: jsonHeaders,
      });
    }

    // Immediate send
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: gmailHeaders,
      body: JSON.stringify({ raw: rawMessage }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      return new Response(JSON.stringify({ error: 'send_failed', details: err }), {
        status: 500, headers: jsonHeaders,
      });
    }

    const result = await sendRes.json();
    return new Response(JSON.stringify({ messageId: result.id, scheduled: false }), {
      headers: jsonHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'internal_error', details: err.message }), {
      status: 500, headers: jsonHeaders,
    });
  }
}
```

**Step 3: Add cron trigger handler**

Add a `scheduled` export to the worker:

```javascript
export default {
  async fetch(request, env) {
    // ... existing fetch handler
  },

  async scheduled(event, env, ctx) {
    // Process scheduled email sends
    const indexRaw = await env.TOKENS.get('scheduled_sends_index');
    if (!indexRaw) return;

    const index = JSON.parse(indexRaw);
    const now = new Date();
    const remaining = [];

    for (const draftId of index) {
      const jobRaw = await env.TOKENS.get(`scheduled:${draftId}`);
      if (!jobRaw) continue;

      const job = JSON.parse(jobRaw);
      const sendAt = new Date(job.sendAt);

      if (sendAt <= now) {
        // Time to send
        try {
          const gmailToken = await getValidGmailToken(env);
          if (!gmailToken) {
            remaining.push(draftId); // retry next cycle
            continue;
          }

          const sendRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/send`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${gmailToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ id: draftId }),
          });

          if (sendRes.ok) {
            // Clean up
            await env.TOKENS.delete(`scheduled:${draftId}`);
          } else {
            remaining.push(draftId); // retry next cycle
          }
        } catch {
          remaining.push(draftId); // retry next cycle
        }
      } else {
        remaining.push(draftId); // not yet time
      }
    }

    // Update index
    if (remaining.length > 0) {
      await env.TOKENS.put('scheduled_sends_index', JSON.stringify(remaining));
    } else {
      await env.TOKENS.delete('scheduled_sends_index');
    }
  },
};
```

**Step 4: Add cron trigger to wrangler.toml**

```toml
[triggers]
crons = ["*/5 * * * *"]
```

**Step 5: Commit**

```bash
git add worker/src/index.js worker/wrangler.toml
git commit -m "feat: add POST /gmail/send with cron-based schedule send"
```

---

### Task 5: Add compose sheet CSS to frontend

Add all styles for the compose sheet, following the existing output-sheet pattern.

**Files:**
- Modify: `filename_generator.html` (CSS section, after output-sheet styles around line 375)

**Step 1: Add compose sheet styles**

Insert after the `.output-sheet-body` styles (after line 375). See design doc for full CSS — compose-overlay, compose-sheet, compose-field, compose-input, compose-textarea, compose-attachment, variation-cards, variation-card, schedule-bar, compose-actions, btn-schedule. Use z-index 2000/2001 to layer above output-sheet (1000/1001).

**Step 2: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add compose sheet CSS"
```

---

### Task 6: Add compose sheet HTML to frontend

Add the compose sheet markup after the output sheet.

**Files:**
- Modify: `filename_generator.html` (after output-sheet closing `</div>` around line 1279)

**Step 1: Add HTML**

Insert compose-overlay and compose-sheet divs with: handle, header (title + close button), body containing compose fields (To input, Subject input, Body textarea, variation-cards container, attachment display, schedule bar with datetime and tz spans, action buttons for Send Now and Schedule Send).

**Step 2: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add compose sheet HTML"
```

---

### Task 7: Add compose sheet JavaScript to frontend

Wire up the compose sheet: open/close, load data, variation selection, schedule picker, and send.

**Files:**
- Modify: `filename_generator.html` (script section)

**Step 1: Add message variations array and composeState object** after `gmailConnected` declaration (~line 1305).

**Step 2: Add `openComposeSheet()` and `closeComposeSheet()` functions.**

**Step 3: Replace `draftInvoiceEmail()` with `openComposeEmail()`** — fetches recipient, timezone, and last variation in parallel via Promise.all, populates compose fields, calls `selectVariation()` and `setDefaultSchedule()`.

**Step 4: Add `selectVariation(lastIndex)`** — picks random variation excluding lastIndex, loads into textarea, renders variation cards using DOM methods (createElement, textContent — no innerHTML with untrusted data).

**Step 5: Add schedule functions** — `setDefaultSchedule()` (tomorrow 8am client TZ), `updateScheduleDisplay()`, `openSchedulePicker()` (native datetime-local input), `openTzPicker()` (cycles ET/CT/MT/PT).

**Step 6: Add `sendInvoiceEmail(scheduled)`** — validates fields, POSTs to `/gmail/send`, fires variation PUT, closes sheet, shows toast.

**Step 7: Update button onclick** — change `draftInvoiceEmail()` to `openComposeEmail()` on the button at line 1271. Update button text to "Compose Invoice Email".

**Step 8: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add compose sheet JavaScript — open, variations, schedule, send"
```

---

### Task 8: Include contactId in invoice list response and set in compose state

**Files:**
- Modify: `worker/src/index.js:240-253` (invoice mapping)
- Modify: `filename_generator.html` (invoice selection handler)

**Step 1:** Add `contactId: inv.Contact?.ContactID || ''` to invoice mapping in worker.

**Step 2:** In `populateFieldsFromInvoice`, add `composeState.contactId = selectedInvoice.contactId || null;`

**Step 3: Commit**

```bash
git add worker/src/index.js filename_generator.html
git commit -m "feat: include contactId in invoice list, set in compose state"
```

---

### Task 9: Remove old draft flow

**Files:**
- Modify: `worker/src/index.js` (remove `/gmail/draft` route and `handleGmailDraft` function)
- Modify: `filename_generator.html` (remove old `draftInvoiceEmail` function)

**Step 1:** Remove draft route from route table.
**Step 2:** Remove `handleGmailDraft` function (lines 382-476).
**Step 3:** Remove old `draftInvoiceEmail` function from frontend.
**Step 4: Commit**

```bash
git add worker/src/index.js filename_generator.html
git commit -m "refactor: remove old gmail draft flow"
```

---

### Task 10: Deploy worker and test end-to-end

**Step 1: Deploy worker**

```bash
cd worker && npx wrangler deploy
```

**Step 2: Test flow**

1. Select an invoice
2. Tap "Compose Invoice Email"
3. Verify: To field pre-filled, subject pre-filled, body has a variation loaded, attachment filename shown, schedule defaults to tomorrow 8am in client timezone
4. Test variation card switching
5. Test "Send Now" — verify email received
6. Test "Schedule Send" — verify draft created and cron sends it
7. Test timezone cycling
8. Test date/time picker
9. Test on mobile (Samsung S24U)

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```
