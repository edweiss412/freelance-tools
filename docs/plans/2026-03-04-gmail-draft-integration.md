# Gmail Draft Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Draft Invoice Email" button that creates a Gmail draft with the generated subject, template body, renamed PDF attachment, and auto-detected recipient.

**Architecture:** Extend the existing Cloudflare Worker with Google OAuth (mirroring the Xero pattern) and a POST endpoint that fetches the Xero PDF, searches Gmail sent mail for the last recipient, and creates a draft. Frontend gets a Connect Gmail button and a Draft Email button.

**Tech Stack:** Cloudflare Workers, KV storage, Gmail API v1, Google OAuth 2.0, vanilla JS frontend

---

### Task 1: Google Cloud Project Setup (Manual)

**This is a manual prerequisite — not code.**

**Step 1: Create Google OAuth credentials**

1. Go to https://console.cloud.google.com/
2. Create a new project (or reuse existing)
3. Enable the Gmail API: APIs & Services > Enable APIs > search "Gmail API" > Enable
4. Create OAuth consent screen: APIs & Services > OAuth consent screen
   - User type: External
   - App name: "Invoice Filename Generator"
   - Scopes: add `https://www.googleapis.com/auth/gmail.compose` and `https://www.googleapis.com/auth/gmail.readonly`
   - Test users: add `edweiss412@gmail.com`
5. Create credentials: APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID
   - Application type: Web application
   - Authorized redirect URI: `https://xero-invoice-proxy.edweiss412.workers.dev/gmail/callback`
6. Note the Client ID and Client Secret

**Step 2: Add secrets to Cloudflare Worker**

```bash
cd worker
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**Step 3: Add env vars to wrangler.toml**

Add under `[vars]`:
```toml
GOOGLE_REDIRECT_URI = "https://xero-invoice-proxy.edweiss412.workers.dev/gmail/callback"
```

**Step 4: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore: add Google redirect URI to worker config"
```

---

### Task 2: Worker — Google OAuth Flow

**Files:**
- Modify: `worker/src/index.js`

**Step 1: Add Gmail auth route handler**

Add to the `fetch` handler's route matching, after the existing Xero routes:

```js
if (path === '/gmail/auth') return handleGmailAuth(env);
if (path === '/gmail/callback') return handleGmailCallback(url, env);
```

**Step 2: Implement `handleGmailAuth`**

```js
function handleGmailAuth(env) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    scope: 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state: crypto.randomUUID(),
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}
```

**Step 3: Implement `handleGmailCallback`**

```js
async function handleGmailCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing code', { status: 400 });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(`Google token exchange failed: ${err}`, { status: 500 });
  }

  const tokens = await tokenRes.json();
  await env.TOKENS.put('gmail_access_token', tokens.access_token, { expirationTtl: 3600 });
  if (tokens.refresh_token) {
    await env.TOKENS.put('gmail_refresh_token', tokens.refresh_token);
  }

  return Response.redirect(env.FRONTEND_URL, 302);
}
```

**Step 4: Implement `getValidGmailToken`** (mirrors `getValidToken` for Xero)

```js
async function getValidGmailToken(env) {
  let accessToken = await env.TOKENS.get('gmail_access_token');
  if (accessToken) return accessToken;

  const refreshToken = await env.TOKENS.get('gmail_refresh_token');
  if (!refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    await env.TOKENS.delete('gmail_refresh_token');
    return null;
  }

  const tokens = await res.json();
  await env.TOKENS.put('gmail_access_token', tokens.access_token, { expirationTtl: 3600 });
  return tokens.access_token;
}
```

**Step 5: Add a `/gmail/status` route** so the frontend can check if Gmail is connected

Add to route matching:
```js
if (path === '/gmail/status') return handleGmailStatus(env);
```

```js
async function handleGmailStatus(env) {
  const headers = corsHeaders(env);
  const token = await getValidGmailToken(env);
  return new Response(JSON.stringify({ connected: !!token }), {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
```

**Step 6: Update CORS to allow POST**

In `corsHeaders`, change:
```js
'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
```

**Step 7: Test manually**

Visit `https://xero-invoice-proxy.edweiss412.workers.dev/gmail/auth` in a browser. Should redirect to Google consent, then back to the frontend. Then `curl https://xero-invoice-proxy.edweiss412.workers.dev/gmail/status` should return `{"connected":true}`.

**Step 8: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add Google OAuth flow for Gmail integration"
```

---

### Task 3: Worker — Gmail Draft Creation Endpoint

**Files:**
- Modify: `worker/src/index.js`

**Step 1: Add route for POST /gmail/draft**

Add to route matching:
```js
if (path === '/gmail/draft' && request.method === 'POST') return handleGmailDraft(request, env);
```

**Step 2: Implement recipient lookup helper**

```js
async function findLastRecipient(gmailToken, hiringEntity) {
  const query = `from:me subject:"Invoice for Labor" "${hiringEntity}" in:sent`;
  const params = new URLSearchParams({ q: query, maxResults: '1' });
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { 'Authorization': `Bearer ${gmailToken}` },
  });

  if (!res.ok) return null;

  const data = await res.json();
  if (!data.messages || data.messages.length === 0) return null;

  const msgRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.messages[0].id}?format=metadata&metadataHeaders=To`,
    { headers: { 'Authorization': `Bearer ${gmailToken}` } }
  );

  if (!msgRes.ok) return null;

  const msg = await msgRes.json();
  const toHeader = msg.payload?.headers?.find(h => h.name === 'To');
  return toHeader?.value || null;
}
```

**Step 3: Implement MIME message builder**

```js
function buildMimeMessage({ to, subject, body, pdfBytes, pdfFilename }) {
  const boundary = `boundary_${crypto.randomUUID()}`;

  // Base64url encode the PDF
  const pdfBase64 = btoa(String.fromCharCode(...new Uint8Array(pdfBytes)));

  let mime = '';
  mime += `To: ${to || ''}\r\n`;
  mime += `Subject: ${subject}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;
  mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
  mime += `${body}\r\n\r\n`;
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: application/pdf\r\n`;
  mime += `Content-Disposition: attachment; filename="${pdfFilename}"\r\n`;
  mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
  mime += `${pdfBase64}\r\n`;
  mime += `--${boundary}--`;

  return mime;
}

function base64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
```

**Step 4: Implement `handleGmailDraft`**

```js
async function handleGmailDraft(request, env) {
  const headers = corsHeaders(env);

  const gmailToken = await getValidGmailToken(env);
  if (!gmailToken) {
    return new Response(JSON.stringify({ error: 'gmail_auth_required' }), {
      status: 401,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const { invoiceId, subject, hiringEntity, filename } = await request.json();

  // Fetch PDF from Xero
  const xeroToken = await getValidToken(env);
  if (!xeroToken) {
    return new Response(JSON.stringify({ error: 'xero_auth_required' }), {
      status: 401,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const tenantId = await env.TOKENS.get('tenant_id');
  const pdfRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
    headers: {
      'Authorization': `Bearer ${xeroToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/pdf',
    },
  });

  if (!pdfRes.ok) {
    return new Response(JSON.stringify({ error: 'pdf_fetch_failed' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const pdfBytes = await pdfRes.arrayBuffer();

  // Look up recipient from Gmail history
  const to = await findLastRecipient(gmailToken, hiringEntity);

  // Build email
  const body = "Good Morning!\r\n\r\nI've attached my invoice for this one. Let me know if there's any issues in processing.\r\n\r\nThanks!\r\n\r\nEric";
  const mime = buildMimeMessage({ to: to || '', subject, body, pdfBytes, pdfFilename: filename });
  const raw = base64url(mime);

  // Create draft
  const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gmailToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!draftRes.ok) {
    const err = await draftRes.text();
    return new Response(JSON.stringify({ error: 'draft_creation_failed', details: err }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const draft = await draftRes.json();
  const draftUrl = `https://mail.google.com/mail/u/0/#drafts/${draft.message.id}`;

  return new Response(JSON.stringify({ draftId: draft.id, draftUrl }), {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
```

**Step 5: Test manually**

```bash
curl -X POST https://xero-invoice-proxy.edweiss412.workers.dev/gmail/draft \
  -H "Content-Type: application/json" \
  -d '{"invoiceId":"<real-id>","subject":"Test Subject","hiringEntity":"Black Oak","filename":"test.pdf"}'
```

**Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add Gmail draft creation endpoint with recipient lookup"
```

---

### Task 4: Worker — Deploy and Verify

**Step 1: Deploy**

```bash
cd worker
npx wrangler deploy
```

**Step 2: Verify routes respond**

```bash
curl -I https://xero-invoice-proxy.edweiss412.workers.dev/gmail/status
# Expect: 200 with JSON

curl -X OPTIONS https://xero-invoice-proxy.edweiss412.workers.dev/gmail/draft \
  -H "Origin: https://edweiss412.github.io"
# Expect: 200 with CORS headers including POST
```

**Step 3: Commit** (if any fixes needed)

---

### Task 5: Frontend — Connect Gmail Button

**Files:**
- Modify: `filename_generator.html`

**Step 1: Add Connect Gmail button**

Below the existing `<button class="calendar-btn" id="authorize_button" ...>` block, add:

```html
<button class="calendar-btn" id="gmail_connect_btn" onclick="connectGmail()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <polyline points="22,6 12,13 2,6"/>
    </svg>
    Connect Gmail
</button>
```

**Step 2: Add `connectGmail` and `checkGmailStatus` functions**

```js
let gmailConnected = false;

async function connectGmail() {
    window.location.href = `${WORKER_URL}/gmail/auth`;
}

async function checkGmailStatus() {
    try {
        const res = await fetch(`${WORKER_URL}/gmail/status`);
        if (!res.ok) return;
        const data = await res.json();
        gmailConnected = data.connected;
        if (gmailConnected) {
            const btn = document.getElementById('gmail_connect_btn');
            btn.textContent = '';
            const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            checkSvg.setAttribute('viewBox', '0 0 24 24');
            checkSvg.setAttribute('fill', 'none');
            checkSvg.setAttribute('stroke', 'currentColor');
            checkSvg.setAttribute('stroke-width', '2.5');
            checkSvg.setAttribute('stroke-linecap', 'round');
            checkSvg.setAttribute('stroke-linejoin', 'round');
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', '20 6 9 17 4 12');
            checkSvg.appendChild(polyline);
            btn.appendChild(checkSvg);
            btn.appendChild(document.createTextNode(' Gmail Connected'));
            btn.style.borderColor = 'var(--success)';
            btn.style.color = 'var(--success)';
            btn.style.background = 'var(--success-bg)';
        }
    } catch (err) {
        console.error('Gmail status check failed:', err);
    }
}
```

**Step 3: Call `checkGmailStatus` on page load**

In `window.onload`, add at the end:
```js
checkGmailStatus();
```

**Step 4: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add Connect Gmail button to frontend"
```

---

### Task 6: Frontend — Draft Invoice Email Button

**Files:**
- Modify: `filename_generator.html`

**Step 1: Add "Draft Invoice Email" button in the output card**

After the existing `downloadPdfBtn` button in the output card, add:

```html
<button class="submit-btn download-btn" id="draftEmailBtn" style="display: none;" onclick="draftInvoiceEmail()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <polyline points="22,6 12,13 2,6"/>
    </svg>
    Draft Invoice Email
</button>
```

**Step 2: Show/hide the button in `generateFilename`**

After the existing `downloadBtn.style.display = ...` line, add:

```js
const draftEmailBtn = document.getElementById('draftEmailBtn');
draftEmailBtn.style.display = (selectedInvoiceId && gmailConnected) ? '' : 'none';
```

**Step 3: Implement `draftInvoiceEmail`**

```js
async function draftInvoiceEmail() {
    if (!selectedInvoiceId) return;

    const btn = document.getElementById('draftEmailBtn');
    btn.disabled = true;
    setButtonLoadingGeneric(btn, 'Creating draft...');

    try {
        const subject = document.getElementById('emailSubject').textContent;
        const filename = document.getElementById('filename').textContent;
        const hiringEntity = document.getElementById('hiringEntity').value;

        const res = await fetch(`${WORKER_URL}/gmail/draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: selectedInvoiceId, subject, hiringEntity, filename }),
        });

        if (res.status === 401) {
            const data = await res.json();
            if (data.error === 'gmail_auth_required') {
                showToast('Gmail session expired — reconnect');
                return;
            }
            showToast('Xero session expired — reload invoices');
            return;
        }

        if (!res.ok) throw new Error(`Draft creation failed: ${res.status}`);

        const data = await res.json();
        window.open(data.draftUrl, '_blank');
        showToast('Draft created — opened in Gmail');
    } catch (err) {
        console.error('Draft creation failed:', err);
        showToast('Failed to create draft');
    } finally {
        btn.disabled = false;
        setButtonLoadingGeneric(btn, null);
    }
}
```

**Step 4: Add generic loading helper** (reuses the pattern from `setButtonLoading` but for any button/label)

```js
function setButtonLoadingGeneric(btn, loadingText) {
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    if (loadingText) {
        svg.style.animation = 'spin 1s linear infinite';
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M21 12a9 9 0 1 1-6.219-8.56');
        svg.appendChild(path);
        btn.appendChild(svg);
        btn.appendChild(document.createTextNode(` ${loadingText}`));
    } else {
        // Restore email icon
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z');
        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', '22,6 12,13 2,6');
        svg.appendChild(path);
        svg.appendChild(polyline);
        btn.appendChild(svg);
        btn.appendChild(document.createTextNode(' Draft Invoice Email'));
    }
}
```

**Step 5: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add Draft Invoice Email button with Gmail draft creation"
```

---

### Task 7: End-to-End Test

**Step 1: Full flow test**

1. Open `filename_generator.html`
2. Click "Load Xero Invoices" — should connect and populate dropdown
3. Click "Connect Gmail" — should redirect to Google consent, then back with "Gmail Connected"
4. Select an invoice from the dropdown — fields auto-fill
5. Click "Generate Filename" — output card appears with filename, email subject, Download PDF, AND Draft Invoice Email buttons
6. Click "Draft Invoice Email" — should show loading spinner, then open Gmail in a new tab with:
   - Subject pre-filled with the email subject
   - Body: "Good Morning!..." template
   - PDF attached with the renamed filename
   - To field pre-filled if the hiring entity has been emailed before

**Step 2: Test edge cases**

- New client (no prior emails): To field should be empty in the draft
- Gmail token expired: should show "Gmail session expired" toast
- Xero token expired: should show "Xero session expired" toast

**Step 3: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "fix: address issues found in e2e testing"
```
