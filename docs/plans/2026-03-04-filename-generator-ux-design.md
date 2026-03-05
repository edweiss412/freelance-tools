# Filename Generator UX Improvements Design

**Date:** 2026-03-04
**File:** `filename_generator.html`

## Problem

Nine UX issues identified in the invoice filename generator tool, ranging from inconsistent terminology to missing loading/error states.

## Changes

### 1. Rename to "Booking" terminology

All user-facing text changes from "Invoice"/"event" to "Booking":
- Label: "Invoice" → "Booking"
- Dropdown placeholder: "Select an event" → "Select a booking"
- Manual field placeholder: "Enter event name..." → "Enter booking name..."
- Internal IDs (`eventName`, `manualEventName`) stay unchanged to avoid breaking JS logic

### 2. Clarify manual entry vs. booking selection

- Divider text: "or type manually" → "or enter details manually"
- Add helper text below manual input: "Selecting a booking above auto-fills all fields. Typing here overrides only the booking name."

### 3 & 4. Connection status bar (replaces connect buttons)

Replace the two connect buttons with a persistent status bar at the top of the card:
- Two items: `● Xero` and `● Gmail`
- Green dot + label when connected, gray dot + "Connect" link when disconnected
- Clicking a disconnected item triggers the same auth flows as before
- Always visible — no hiding/showing, no dual-purpose action/status elements

### 5. Loading state for initial invoice fetch

- On page load, disable the booking dropdown with placeholder "Loading bookings..."
- Show a subtle spinner or pulsing state
- Once `loadInvoices` resolves, swap to populated dropdown or "Select a booking"
- On error, show "Failed to load — retry" in the dropdown

### 6. Extract shared date-range logic

- Create `collapseDateRanges(sortedDates)` function
- Returns array of formatted range strings
- Used by both `generateFilename` and `generateEmailSubject`
- Pure refactor, no visible change

### 7. Persistent inline error banners

- Critical errors (auth expired, API failures) show an inline alert banner at top of the card
- Banner has a dismiss button and persists until dismissed or issue resolved
- Toasts remain for success confirmations only (copied, downloaded, draft created)

### 8. Editable output fields

- Output spans become `contenteditable` divs
- Copy button copies current content (whether auto-generated or hand-edited)
- Subtle "edited" indicator appears if user modifies generated text
- Styling matches current read-only appearance

### 9. Password visibility toggle

- Add eye/eye-off icon toggle inside the password input
- Toggles input type between "password" and "text"
