# Filename Generator UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 9 UX issues in `filename_generator.html` — terminology, status indicators, loading states, error handling, editable outputs, and code dedup.

**Architecture:** Single-file HTML app. All changes are CSS + HTML + vanilla JS within `filename_generator.html`. No backend changes needed.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Flatpickr

---

### Task 1: Rename terminology from "Invoice"/"event" to "Booking"

**Files:**
- Modify: `filename_generator.html:601-606` (form labels and placeholders)
- Modify: `filename_generator.html:810-811` (JS default option text)

**Step 1: Update the form HTML**

Change lines 601-606 from:
```html
<label for="eventName">Invoice</label>
<select id="eventName" name="eventName">
    <option value="">Select an event</option>
</select>
<div class="or-divider">or type manually</div>
<input type="text" id="manualEventName" name="manualEventName" placeholder="Enter event name...">
```
to:
```html
<label for="eventName">Booking</label>
<select id="eventName" name="eventName">
    <option value="">Select a booking</option>
</select>
<div class="or-divider">or enter details manually</div>
<input type="text" id="manualEventName" name="manualEventName" placeholder="Enter booking name...">
```

**Step 2: Update the JS default option in `populateInvoiceDropdown`**

Change line 811 from:
```js
defaultOpt.textContent = 'Select an invoice';
```
to:
```js
defaultOpt.textContent = 'Select a booking';
```

**Step 3: Verify in browser**

Open `filename_generator.html` in browser. Confirm:
- Label says "Booking"
- Dropdown placeholder says "Select a booking"
- Manual input placeholder says "Enter booking name..."
- Divider says "or enter details manually"

**Step 4: Commit**

```bash
git add filename_generator.html
git commit -m "fix: rename invoice/event terminology to booking"
```

---

### Task 2: Add helper text below manual booking input

**Files:**
- Modify: `filename_generator.html` — add CSS for `.field-hint` class (~line 170)
- Modify: `filename_generator.html:606` — add helper element after manual input

**Step 1: Add CSS for field hints**

After the `.label-hint` rule (around line 173), add:
```css
.field-hint {
    font-size: 0.7rem;
    color: var(--text-muted);
    opacity: 0.6;
    margin-top: 6px;
    line-height: 1.4;
}
```

**Step 2: Add helper text after the manual input**

After the manual input element, add:
```html
<p class="field-hint">Selecting a booking above auto-fills all fields. Typing here overrides only the booking name.</p>
```

**Step 3: Verify in browser**

Confirm helper text appears below the manual input in muted, small text.

**Step 4: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add helper text clarifying manual vs booking selection"
```

---

### Task 3: Replace connect buttons with persistent status bar

**Files:**
- Modify: `filename_generator.html` — add CSS for `.status-bar` (~line 109-139, replacing `.calendar-btn` styles)
- Modify: `filename_generator.html:580-597` — replace button HTML with status bar
- Modify: `filename_generator.html` — update `loadInvoices`, `checkGmailStatus`, `connectGmail`, and `window.onload` JS

**Step 1: Add CSS for the status bar**

Replace the `.calendar-btn` CSS block (lines 110-139) with:
```css
/* Status bar */
.status-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 14px;
    background: var(--input-bg);
    border: 1.5px solid var(--input-border);
    border-radius: var(--radius);
    margin-bottom: 24px;
    font-size: 0.8rem;
    font-weight: 500;
}

.status-item {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    cursor: default;
    transition: color var(--transition);
}

.status-item.disconnected {
    cursor: pointer;
}

.status-item.disconnected:hover {
    color: var(--accent);
}

.status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--input-border);
    transition: background var(--transition);
    flex-shrink: 0;
}

.status-item.connected .status-dot {
    background: var(--success);
}

.status-item.connected {
    color: var(--text);
}

.status-separator {
    width: 1px;
    height: 16px;
    background: var(--input-border);
}
```

**Step 2: Replace the button HTML with status bar**

Replace lines 580-597 (the two `<button class="calendar-btn">` elements) with:
```html
<div class="status-bar">
    <div class="status-item disconnected" id="xero_status" onclick="handleXeroClick()">
        <span class="status-dot"></span>
        <span class="status-label">Connect Xero</span>
    </div>
    <div class="status-separator"></div>
    <div class="status-item disconnected" id="gmail_status" onclick="handleGmailClick()">
        <span class="status-dot"></span>
        <span class="status-label">Connect Gmail</span>
    </div>
</div>
```

**Step 3: Update `loadInvoices` to update status bar instead of button**

Replace the success section of `loadInvoices` (the part after `populateInvoiceDropdown` that manipulates `btn`, roughly lines 778-798) with:
```js
const xeroStatus = document.getElementById('xero_status');
xeroStatus.classList.remove('disconnected');
xeroStatus.classList.add('connected');
xeroStatus.querySelector('.status-label').textContent = 'Xero';
xeroStatus.onclick = null;
```

Also update the error/401 handling — on Xero auth redirect (the `else if (!silent)` branch), keep behavior but remove any reference to `btn`. Remove the line `const btn = document.getElementById('authorize_button');` at the top of the function.

**Step 4: Update `checkGmailStatus` to update status bar**

Replace the Gmail connected UI update (roughly lines 1249-1270) with:
```js
const gmailStatus = document.getElementById('gmail_status');
gmailStatus.classList.remove('disconnected');
gmailStatus.classList.add('connected');
gmailStatus.querySelector('.status-label').textContent = 'Gmail';
gmailStatus.onclick = null;
```

**Step 5: Add click handlers and update `connectGmail`**

Add these functions (replace the existing `connectGmail`):
```js
function handleXeroClick() {
    loadInvoices();
}

function handleGmailClick() {
    window.location.href = `${WORKER_URL}/gmail/auth`;
}
```

**Step 6: Update `draftInvoiceEmail` error handling**

In the 401 handler for `gmail_auth_required`, replace the button restoration code with:
```js
const gmailStatus = document.getElementById('gmail_status');
gmailStatus.classList.remove('connected');
gmailStatus.classList.add('disconnected');
gmailStatus.querySelector('.status-label').textContent = 'Connect Gmail';
gmailStatus.onclick = handleGmailClick;
gmailConnected = false;
```

And for Xero session expired:
```js
const xeroStatus = document.getElementById('xero_status');
xeroStatus.classList.remove('connected');
xeroStatus.classList.add('disconnected');
xeroStatus.querySelector('.status-label').textContent = 'Connect Xero';
xeroStatus.onclick = handleXeroClick;
```

**Step 7: Verify in browser**

- Status bar shows "Connect Xero" and "Connect Gmail" with gray dots
- After clicking and authenticating, dots turn green and text shows "Xero" / "Gmail"
- On page reload when already authed, status updates to connected state

**Step 8: Commit**

```bash
git add filename_generator.html
git commit -m "feat: replace connect buttons with persistent status bar"
```

---

### Task 4: Add loading state for initial invoice fetch

**Files:**
- Modify: `filename_generator.html` — update `loadInvoices` JS and `window.onload`

**Step 1: Set dropdown to loading state on page load**

In `window.onload`, before calling `loadInvoices`, add:
```js
const dropdown = document.getElementById('eventName');
dropdown.disabled = true;
dropdown.querySelector('option').textContent = 'Loading bookings...';
```

**Step 2: Update `loadInvoices` to restore dropdown on completion**

At the end of `loadInvoices`, in the success path (after `populateInvoiceDropdown`), add:
```js
document.getElementById('eventName').disabled = false;
```

In the error/early-return paths (401, network error), add:
```js
const dropdown = document.getElementById('eventName');
dropdown.disabled = false;
dropdown.querySelector('option').textContent = 'Select a booking';
```

**Step 3: Verify in browser**

- On page load, dropdown shows "Loading bookings..." and is disabled
- After invoices load, dropdown is enabled and populated
- If load fails, dropdown shows "Select a booking" and is usable for manual entry

**Step 4: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add loading state to booking dropdown on initial fetch"
```

---

### Task 5: Extract shared `collapseDateRanges` function

**Files:**
- Modify: `filename_generator.html` — refactor JS in `generateFilename` and `generateEmailSubject`

**Step 1: Create the shared function**

Add before `generateFilename`:
```js
function collapseDateRanges(sortedDates) {
    if (sortedDates.length === 0) return [];

    const ranges = [];
    let rangeStart = sortedDates[0];
    let rangeEnd = sortedDates[0];

    for (let i = 1; i < sortedDates.length; i++) {
        const diff = Math.round((sortedDates[i].date - sortedDates[i - 1].date) / 86400000);
        if (diff === 1) {
            rangeEnd = sortedDates[i];
        } else {
            ranges.push(rangeStart === rangeEnd ? rangeStart.formatted : `${rangeStart.formatted}-${rangeEnd.formatted}`);
            rangeStart = sortedDates[i];
            rangeEnd = sortedDates[i];
        }
    }
    ranges.push(rangeStart === rangeEnd ? rangeStart.formatted : `${rangeStart.formatted}-${rangeEnd.formatted}`);
    return ranges;
}
```

**Step 2: Replace duplicate code in `generateFilename`**

Replace the date range loop (lines ~1001-1022) with:
```js
const dateRanges = collapseDateRanges(sortedDates);
if (dateRanges.length > 0) {
    filename += ` - ${dateRanges.join('_')}`;
}
```

**Step 3: Replace duplicate code in `generateEmailSubject`**

Replace the date range loop (lines ~1140-1167) with:
```js
const dateRanges = collapseDateRanges(sortedDates);
subject += dateRanges.join(', ');
```

**Step 4: Verify in browser**

Generate a filename with multiple dates. Confirm both the filename and email subject show correctly formatted date ranges.

**Step 5: Commit**

```bash
git add filename_generator.html
git commit -m "refactor: extract shared collapseDateRanges function"
```

---

### Task 6: Add persistent inline error banners

**Files:**
- Modify: `filename_generator.html` — add CSS for `.error-banner`, add HTML element, update JS error handling

**Step 1: Add CSS for error banner**

Add after the `.toast` styles:
```css
/* Error banner */
.error-banner {
    display: none;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    background: #fef2f2;
    border: 1.5px solid #fca5a5;
    border-radius: var(--radius);
    margin-bottom: 20px;
    font-size: 0.85rem;
    color: #991b1b;
    line-height: 1.4;
    animation: fadeUp 0.3s ease-out;
}

.error-banner.show {
    display: flex;
}

.error-banner-message {
    flex: 1;
}

.error-banner-dismiss {
    background: none;
    border: none;
    color: #991b1b;
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    transition: opacity var(--transition);
    flex-shrink: 0;
}

.error-banner-dismiss:hover {
    opacity: 1;
}
```

**Step 2: Add error banner HTML**

Add inside the `.card` div, right after the status bar and before the `<form>`:
```html
<div class="error-banner" id="errorBanner">
    <span class="error-banner-message" id="errorBannerMessage"></span>
    <button class="error-banner-dismiss" onclick="dismissError()" title="Dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
    </button>
</div>
```

**Step 3: Add JS helper functions**

```js
function showError(message) {
    const banner = document.getElementById('errorBanner');
    document.getElementById('errorBannerMessage').textContent = message;
    banner.classList.add('show');
}

function dismissError() {
    document.getElementById('errorBanner').classList.remove('show');
}
```

**Step 4: Replace `showToast` calls for errors with `showError`**

In `loadInvoices` catch block: replace `showToast('Failed to load invoices')` with `showError('Failed to load bookings. Check your connection and try again.')`.

In `downloadPdf`: replace `showToast('Session expired — reload invoices')` with `showError('Xero session expired. Reconnect to continue.')`. Replace `showToast('Failed to download PDF')` with `showError('Failed to download PDF. Try again.')`.

In `draftInvoiceEmail`: replace `showToast('Gmail session expired — reconnect')` with `showError('Gmail session expired. Reconnect to continue.')`. Replace `showToast('Xero session expired — reload invoices')` with `showError('Xero session expired. Reconnect to continue.')`. Replace `showToast('Failed to create draft')` with `showError('Failed to create email draft. Try again.')`.

Keep `showToast` for success messages (copied, downloaded, draft created).

**Step 5: Auto-dismiss error on successful action**

At the top of `loadInvoices` success path and `checkGmailStatus` success path, call `dismissError()`.

**Step 6: Verify in browser**

- Simulate a network error — banner appears and persists
- Click dismiss — banner disappears
- Success action — banner auto-dismisses
- Success actions still use toast

**Step 7: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add persistent error banners for critical failures"
```

---

### Task 7: Make output fields editable

**Files:**
- Modify: `filename_generator.html:648-674` — change output spans to contenteditable
- Modify: `filename_generator.html` — add CSS for editable state and "edited" badge
- Modify: `filename_generator.html` — update JS `generateFilename` and `copyToClipboard`

**Step 1: Add CSS for editable outputs and edited badge**

Add after `.output-value` styles:
```css
.output-value[contenteditable] {
    cursor: text;
    outline: none;
}

.output-value[contenteditable]:focus {
    border-color: var(--input-focus);
    box-shadow: 0 0 0 3px var(--accent-glow);
}

.output-edited {
    display: none;
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
    margin-left: auto;
}

.output-edited.show {
    display: inline;
}
```

**Step 2: Update output HTML**

Replace the filename output section (lines 648-656):
```html
<div class="output-value" id="filenameOutput" contenteditable="true" data-original="">
    <button class="copy-btn" onclick="copyToClipboard('filenameOutput', this)" title="Copy filename">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
    </button>
</div>
```

And add `<span class="output-edited" id="filenameEdited">edited</span>` inside the `.output-label` div for filename.

Do the same for the email subject output — `id="emailSubjectOutput"`, copy calls `copyToClipboard('emailSubjectOutput', this)`, edited badge `id="emailSubjectEdited"`.

**Step 3: Update `generateFilename` to set content**

Replace the lines that set `textContent` on the old spans:
```js
const filenameEl = document.getElementById('filenameOutput');
const emailEl = document.getElementById('emailSubjectOutput');

// Set text content (excluding the copy button)
setOutputText(filenameEl, filename);
setOutputText(emailEl, emailSubject);

// Store originals for edit detection
filenameEl.dataset.original = filename;
emailEl.dataset.original = emailSubject;

// Reset edited badges
document.getElementById('filenameEdited').classList.remove('show');
document.getElementById('emailSubjectEdited').classList.remove('show');
```

**Step 4: Add helper functions for contenteditable**

```js
function setOutputText(el, text) {
    // Preserve the copy button, set text before it
    const copyBtn = el.querySelector('.copy-btn');
    // Remove all text nodes
    Array.from(el.childNodes).forEach(node => {
        if (node !== copyBtn) el.removeChild(node);
    });
    el.insertBefore(document.createTextNode(text), copyBtn);
}

function getOutputText(el) {
    // Get text content excluding the copy button
    let text = '';
    el.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    });
    return text.trim();
}
```

**Step 5: Update `copyToClipboard` to read from contenteditable**

Change `copyToClipboard` to accept the output div ID and read its text:
```js
function copyToClipboard(outputId, btnEl) {
    const el = document.getElementById(outputId);
    const text = getOutputText(el);
    if (!text) return;
    // ... rest of clipboard logic stays the same
}
```

**Step 6: Add input listeners for edit detection**

In `window.onload`, add:
```js
document.getElementById('filenameOutput').addEventListener('input', function() {
    const edited = getOutputText(this) !== this.dataset.original;
    document.getElementById('filenameEdited').classList.toggle('show', edited);
});

document.getElementById('emailSubjectOutput').addEventListener('input', function() {
    const edited = getOutputText(this) !== this.dataset.original;
    document.getElementById('emailSubjectEdited').classList.toggle('show', edited);
});
```

**Step 7: Prevent Enter key from adding line breaks**

Add in `window.onload`:
```js
document.querySelectorAll('.output-value[contenteditable]').forEach(el => {
    el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') e.preventDefault();
    });
});
```

**Step 8: Update auto-copy in `generateFilename`**

Change the auto-copy line to use the new ID:
```js
copyToClipboard('filenameOutput', document.querySelector('#filenameOutput .copy-btn'));
```

**Step 9: Verify in browser**

- Generate a filename — outputs appear and filename is auto-copied
- Click into an output — it becomes editable with focus ring
- Edit text — "edited" badge appears
- Copy button copies the edited text
- Re-generate — resets content and clears "edited" badge

**Step 10: Commit**

```bash
git add filename_generator.html
git commit -m "feat: make output fields editable with edit detection"
```

---

### Task 8: Add password visibility toggle

**Files:**
- Modify: `filename_generator.html` — add CSS for toggle, update login modal HTML, add JS

**Step 1: Add CSS for password toggle**

Add after `.login-error` styles:
```css
.password-wrapper {
    position: relative;
}

.password-wrapper input {
    padding-right: 42px;
}

.password-toggle {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    opacity: 0.6;
    transition: opacity var(--transition);
}

.password-toggle:hover {
    opacity: 1;
}
```

**Step 2: Wrap the password input**

Replace line 701:
```html
<input type="password" id="login_password" placeholder="Password" autocomplete="current-password" required>
```
with:
```html
<div class="password-wrapper">
    <input type="password" id="login_password" placeholder="Password" autocomplete="current-password" required>
    <button type="button" class="password-toggle" onclick="togglePassword()" title="Show password">
        <svg id="eye_icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
        </svg>
    </button>
</div>
```

**Step 3: Add toggle JS**

```js
function togglePassword() {
    const input = document.getElementById('login_password');
    const icon = document.getElementById('eye_icon');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';

    // Swap icon
    while (icon.firstChild) icon.removeChild(icon.firstChild);
    if (isPassword) {
        // Eye-off icon
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19');
        const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path3.setAttribute('d', 'M14.12 14.12a3 3 0 1 1-4.24-4.24');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '1'); line.setAttribute('y1', '1');
        line.setAttribute('x2', '23'); line.setAttribute('y2', '23');
        icon.append(path1, path2, path3, line);
    } else {
        // Eye icon
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '3');
        icon.append(path, circle);
    }
}
```

**Step 4: Verify in browser**

- Login modal shows eye icon
- Click toggles between password/text
- Icon swaps between eye and eye-off

**Step 5: Commit**

```bash
git add filename_generator.html
git commit -m "feat: add password visibility toggle to login modal"
```

---

### Task 9: Final verification and cleanup

**Step 1: Full walkthrough**

Open the file in browser and verify all 9 fixes work together:
1. "Booking" terminology everywhere
2. Helper text below manual input
3. Status bar shows connection state
4. Dropdown shows "Loading bookings..." on load
5. Date ranges work identically in filename and email subject
6. Error banner appears for failures, persists until dismissed
7. Output fields are editable, "edited" badge works
8. Password toggle works
9. Toasts only for success, banners for errors

**Step 2: Check for dead code**

Remove any remaining references to `authorize_button`, `gmail_connect_btn`, or the old `connectGmail` function if they're no longer used.

**Step 3: Commit if any cleanup needed**

```bash
git add filename_generator.html
git commit -m "chore: remove dead code from connect button migration"
```
