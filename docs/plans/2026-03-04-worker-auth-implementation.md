# Worker Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect the Cloudflare Worker API with password-based login and 30-day signed session cookies.

**Architecture:** A middleware auth check runs before every route except OPTIONS, POST /login, and OAuth callbacks. Login sets an HMAC-signed cookie. The frontend shows a login modal on 401 and retries after authentication.

**Tech Stack:** Cloudflare Workers (Web Crypto API for HMAC-SHA256), KV (existing), vanilla JS frontend

---

### Task 1: Add auth helpers to the worker

**Files:**
- Modify: `worker/src/index.js:1-35`

**Step 1: Add session cookie helpers at the top of the file (after line 26, before `corsHeaders`)**

Add these functions to `worker/src/index.js` after the default export closing brace:

```javascript
// --- Auth helpers ---

const THIRTY_DAYS = 30 * 24 * 60 * 60;

async function createSessionCookie(env) {
  const expiry = Math.floor(Date.now() / 1000) + THIRTY_DAYS;
  const expiryHex = expiry.toString(16);
  const signature = await hmacSign(expiryHex, env.AUTH_SECRET);
  const cookie = `session=${expiryHex}.${signature}; HttpOnly; Secure; SameSite=None; Max-Age=${THIRTY_DAYS}; Path=/`;
  return cookie;
}

async function verifySession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return false;

  const [expiryHex, signature] = match[1].split('.');
  if (!expiryHex || !signature) return false;

  const expiry = parseInt(expiryHex, 16);
  if (isNaN(expiry) || expiry < Date.now() / 1000) return false;

  const expected = await hmacSign(expiryHex, env.AUTH_SECRET);
  return signature === expected;
}

async function hmacSign(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

**Step 2: Add the login handler**

```javascript
async function handleLogin(request, env) {
  const headers = corsHeaders(env);

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers });
  }

  try {
    const { password } = await request.json();
    if (password !== env.AUTH_PASSWORD) {
      return new Response(JSON.stringify({ error: 'invalid_password' }), {
        status: 401,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const cookie = await createSessionCookie(env);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Set-Cookie': cookie,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'bad_request' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
}
```

**Step 3: Add auth middleware to the main fetch handler and login route**

Replace the existing `fetch` handler with:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — always allow
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // Login endpoint — no auth required
    if (path === '/login') return handleLogin(request, env);

    // OAuth callbacks — no auth required (mid-flow redirects)
    if (path === '/callback') return handleCallback(url, env);
    if (path === '/gmail/callback') return handleGmailCallback(url, env);

    // All other routes require valid session
    const authenticated = await verifySession(request, env);
    if (!authenticated) {
      return new Response(JSON.stringify({ error: 'auth_required' }), {
        status: 401,
        headers: { ...corsHeaders(env), 'Content-Type': 'application/json' },
      });
    }

    if (path === '/auth') return handleAuth(env);
    if (path === '/invoices') return handleInvoices(env);

    const pdfMatch = path.match(/^\/invoices\/([a-f0-9-]+)\/pdf$/i);
    if (pdfMatch) return handleInvoicePdf(pdfMatch[1], env);

    if (path === '/gmail/auth') return handleGmailAuth(env);
    if (path === '/gmail/status') return handleGmailStatus(env);
    if (path === '/gmail/draft' && request.method === 'POST') return handleGmailDraft(request, env);

    return new Response('Not found', { status: 404 });
  }
};
```

**Step 4: Update CORS headers to allow credentials**

Update `corsHeaders` function:

```javascript
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
}
```

**Step 5: Verify the worker builds**

Run: `cd worker && npx wrangler deploy --dry-run`
Expected: No syntax errors

**Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add auth middleware with password login and session cookies"
```

---

### Task 2: Add `credentials: 'include'` to all frontend fetch calls

**Files:**
- Modify: `filename_generator.html`

The browser won't send cross-origin cookies unless `credentials: 'include'` is set on every fetch. Update all existing `fetch()` calls to include this option.

**Step 1: Update all fetch calls**

There are 5 fetch calls to update in `filename_generator.html`:

1. `loadInvoices` (line ~622):
```javascript
const res = await fetch(`${WORKER_URL}/invoices`, { credentials: 'include' });
```

2. `handleInvoicePdf` fetch (line ~943):
```javascript
const res = await fetch(`${WORKER_URL}/invoices/${selectedInvoiceId}/pdf`, { credentials: 'include' });
```

3. `checkGmailStatus` (line ~1091):
```javascript
const res = await fetch(`${WORKER_URL}/gmail/status`, { credentials: 'include' });
```

4. `handleGmailDraft` fetch (line ~1148):
```javascript
const res = await fetch(`${WORKER_URL}/gmail/draft`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ... }),
});
```

**Step 2: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add credentials include to all worker fetch calls"
```

---

### Task 3: Add login modal to the frontend

**Files:**
- Modify: `filename_generator.html`

**Step 1: Add login modal HTML before the closing `</body>` tag (after the toast div, before `<script>`)**

Insert after line 611 (`<div class="toast" id="toast"></div>`):

```html
<div class="login-overlay" id="login_overlay" style="display:none">
    <div class="login-modal">
        <h2>Login Required</h2>
        <p>Enter your password to continue.</p>
        <form id="login_form" onsubmit="handleLoginSubmit(event)">
            <input type="password" id="login_password" placeholder="Password" autocomplete="current-password" required>
            <button type="submit" class="login-btn" id="login_btn">Login</button>
            <p class="login-error" id="login_error"></p>
        </form>
    </div>
</div>
```

**Step 2: Add login modal CSS**

Add to the `<style>` block (after the `.toast.show` rules around line 385):

```css
.login-overlay {
    position: fixed;
    inset: 0;
    background: rgba(26, 24, 20, 0.85);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.login-modal {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: var(--radius-lg);
    padding: 40px;
    max-width: 360px;
    width: 100%;
    box-shadow: var(--shadow-lg);
    text-align: center;
}

.login-modal h2 {
    font-family: 'Instrument Serif', serif;
    font-size: 1.5rem;
    color: var(--text);
    margin-bottom: 8px;
}

.login-modal p {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 20px;
}

.login-modal input {
    width: 100%;
    padding: 10px 14px;
    border: 1.5px solid var(--input-border);
    border-radius: var(--radius);
    font-family: inherit;
    font-size: 0.95rem;
    background: var(--input-bg);
    color: var(--text);
    outline: none;
    transition: border-color var(--transition);
    margin-bottom: 12px;
}

.login-modal input:focus {
    border-color: var(--input-focus);
}

.login-btn {
    width: 100%;
    padding: 10px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius);
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--transition);
}

.login-btn:hover {
    background: var(--accent-hover);
}

.login-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.login-error {
    color: #c0392b;
    font-size: 0.85rem;
    margin-top: 10px;
    min-height: 1.2em;
}
```

**Step 3: Add login JavaScript**

Add to the `<script>` block, after `const WORKER_URL = ...` and before `loadInvoices`:

```javascript
let needsAuth = false;

async function handleLoginSubmit(event) {
    event.preventDefault();
    const btn = document.getElementById('login_btn');
    const errorEl = document.getElementById('login_error');
    const password = document.getElementById('login_password').value;

    btn.disabled = true;
    errorEl.textContent = '';

    try {
        const res = await fetch(`${WORKER_URL}/login`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });

        if (!res.ok) {
            errorEl.textContent = 'Wrong password';
            btn.disabled = false;
            return;
        }

        // Hide modal, retry loading
        document.getElementById('login_overlay').style.display = 'none';
        document.getElementById('login_password').value = '';
        needsAuth = false;

        // Retry auto-load
        loadInvoices({ silent: true });
        checkGmailStatus();
    } catch (err) {
        errorEl.textContent = 'Connection error';
        btn.disabled = false;
    }
}

function showLoginModal() {
    if (needsAuth) return; // already showing
    needsAuth = true;
    document.getElementById('login_overlay').style.display = 'flex';
    document.getElementById('login_password').focus();
}
```

**Step 4: Update `loadInvoices` to show login modal on 401 instead of redirecting to Xero auth**

The 401 handling needs to change. Currently a 401 from `/invoices` means "Xero not authed" — but now the worker returns 401 for *session* auth too. The worker now only returns 401 from the middleware (session) — if Xero tokens are missing, it still returns 401 from `handleInvoices` but only after passing the session check.

Update the 401 handler in `loadInvoices`:

```javascript
if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'auth_required') {
        showLoginModal();
    } else if (!silent) {
        window.location.href = `${WORKER_URL}/auth`;
    }
    return;
}
```

**Step 5: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add login modal and auth handling to frontend"
```

---

### Task 4: Set worker secrets and deploy

**Step 1: Set the worker secrets**

Run:
```bash
cd worker && npx wrangler secret put AUTH_PASSWORD
```
(Enter your chosen password when prompted)

```bash
npx wrangler secret put AUTH_SECRET
```
(Enter a random string — generate one with `openssl rand -hex 32`)

**Step 2: Deploy the worker**

Run: `cd worker && npx wrangler deploy`
Expected: Successful deployment with no errors

**Step 3: Test the auth flow**

1. Open the app in a browser — should see login modal
2. Enter wrong password — should see "Wrong password" error
3. Enter correct password — modal closes, invoices load, Gmail shows connected
4. Refresh the page — should auto-load without login (cookie persists)

**Step 4: Commit any final adjustments**

```bash
git add -A
git commit -m "chore: finalize auth deployment"
```

---

### Task 5: Handle OAuth redirect auth for Xero/Gmail initiation

**Files:**
- Modify: `filename_generator.html`

The Xero and Gmail OAuth flows start by navigating the browser to the worker (`/auth` and `/gmail/auth`). These are now behind the auth middleware, so they need the session cookie. Since the browser navigates directly (not a fetch), the cookie will be sent automatically as long as the user is logged in.

However, if the session has expired when the user clicks "Load Xero Invoices" (which redirects on non-silent 401 from `/invoices`), they'll get a raw 401 JSON response in the browser. Instead, the redirect to `/auth` should go through the app's login flow.

**Step 1: The loadInvoices 401 handling already covers this from Task 3** — if the session is expired, the user sees the login modal instead of being redirected. After login, invoices auto-load. If Xero tokens are expired, the user clicks the button again and the non-silent path triggers the Xero OAuth redirect (which now works because they have a valid session cookie).

No code changes needed — just verify this flow works during Task 4 testing.

**Step 2: Commit (if any tweaks needed)**

```bash
git commit -m "fix: ensure OAuth redirects work with session auth"
```
