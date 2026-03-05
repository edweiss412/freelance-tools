export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — always allow
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // Public routes (no auth required)
    if (path === '/login') return handleLogin(request, env);
    if (path === '/callback') return handleCallback(url, env);
    if (path === '/gmail/callback') return handleGmailCallback(url, env);

    // All other routes require a valid session
    if (!await verifySession(request, env)) {
      return new Response(JSON.stringify({ error: 'auth_required' }), {
        status: 401,
        headers: { ...corsHeaders(env), 'Content-Type': 'application/json' },
      });
    }

    // Authenticated routes
    if (path === '/auth') return handleAuth(env);
    if (path === '/invoices') return handleInvoices(env);

    const pdfMatch = path.match(/^\/invoices\/([a-f0-9-]+)\/pdf$/i);
    if (pdfMatch) return handleInvoicePdf(pdfMatch[1], env);

    // Gmail routes
    if (path === '/gmail/auth') return handleGmailAuth(env);
    if (path === '/gmail/status') return handleGmailStatus(env);
    if (path === '/gmail/draft' && request.method === 'POST') return handleGmailDraft(request, env);
    if (path === '/gmail/recipient' && request.method === 'GET') return handleGmailRecipient(url, env);
    if (path === '/xero/contact-timezone' && request.method === 'GET') return handleContactTimezone(url, env);

    const variationMatch = path.match(/^\/variation\/([a-f0-9-]+)$/i);
    if (variationMatch && request.method === 'GET') return handleGetVariation(variationMatch[1], env);
    if (variationMatch && request.method === 'PUT') return handlePutVariation(variationMatch[1], request, env);

    if (path === '/gmail/send' && request.method === 'POST') return handleGmailSend(request, env);

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
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
        try {
          const gmailToken = await getValidGmailToken(env);
          if (!gmailToken) {
            remaining.push(draftId);
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
            await env.TOKENS.delete(`scheduled:${draftId}`);
          } else {
            remaining.push(draftId);
          }
        } catch {
          remaining.push(draftId);
        }
      } else {
        remaining.push(draftId);
      }
    }

    if (remaining.length > 0) {
      await env.TOKENS.put('scheduled_sends_index', JSON.stringify(remaining));
    } else {
      await env.TOKENS.delete('scheduled_sends_index');
    }
  },
};

const US_STATE_TIMEZONES = {
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', IN: 'America/Indiana/Indianapolis', KY: 'America/New_York',
  MA: 'America/New_York', MD: 'America/New_York', ME: 'America/New_York',
  MI: 'America/New_York', NC: 'America/New_York', NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VA: 'America/New_York', VT: 'America/New_York', WV: 'America/New_York',
  DC: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago',
  IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise',
  MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver',
  WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

const TZ_LABELS = {
  'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT',
  'America/Phoenix': 'MT', 'America/Boise': 'MT',
  'America/Indiana/Indianapolis': 'ET', 'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
};

const DEFAULT_TIMEZONE = 'America/Chicago';
const DEFAULT_TZ_LABEL = 'CT';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// --- Auth helpers ---

const THIRTY_DAYS = 30 * 24 * 60 * 60;

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSessionCookie(env) {
  const expiry = Math.floor(Date.now() / 1000) + THIRTY_DAYS;
  const expiryHex = expiry.toString(16);
  const signature = await hmacSign(expiryHex, env.AUTH_SECRET);
  const value = `session=${expiryHex}.${signature}`;
  return `${value}; HttpOnly; Secure; SameSite=None; Max-Age=${THIRTY_DAYS}; Path=/`;
}

async function verifySession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]+)\.([a-f0-9]+)/);
  if (!match) return false;

  const [, expiryHex, signature] = match;
  const expectedSig = await hmacSign(expiryHex, env.AUTH_SECRET);
  if (signature !== expectedSig) return false;

  const expiry = parseInt(expiryHex, 16);
  if (expiry < Math.floor(Date.now() / 1000)) return false;

  return true;
}

async function handleLogin(request, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: jsonHeaders,
    });
  }

  try {
    const { password } = await request.json();
    if (password !== env.AUTH_PASSWORD) {
      return new Response(JSON.stringify({ error: 'invalid_password' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const cookie = await createSessionCookie(env);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...jsonHeaders, 'Set-Cookie': cookie },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400, headers: jsonHeaders,
    });
  }
}

function handleAuth(env) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: env.XERO_REDIRECT_URI,
    scope: 'openid accounting.invoices.read offline_access',
    state: crypto.randomUUID(),
  });
  return Response.redirect(`https://login.xero.com/identity/connect/authorize?${params}`, 302);
}

async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing code', { status: 400 });

  // Exchange code for tokens
  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.XERO_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(`Token exchange failed: ${err}`, { status: 500 });
  }

  const tokens = await tokenRes.json();

  // Get tenant ID from connections endpoint
  const connRes = await fetch('https://api.xero.com/connections', {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  });
  const connections = await connRes.json();
  const tenantId = connections[0]?.tenantId;

  if (!tenantId) return new Response('No Xero tenant found', { status: 500 });

  // Store in KV
  await env.TOKENS.put('access_token', tokens.access_token, { expirationTtl: 1800 });
  await env.TOKENS.put('refresh_token', tokens.refresh_token);
  await env.TOKENS.put('tenant_id', tenantId);

  return Response.redirect(env.FRONTEND_URL, 302);
}

async function getValidToken(env) {
  let accessToken = await env.TOKENS.get('access_token');
  if (accessToken) return accessToken;

  // Access token expired, refresh it
  const refreshToken = await env.TOKENS.get('refresh_token');
  if (!refreshToken) return null;

  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    // Refresh token expired — need re-auth
    await env.TOKENS.delete('refresh_token');
    return null;
  }

  const tokens = await res.json();
  await env.TOKENS.put('access_token', tokens.access_token, { expirationTtl: 1800 });
  await env.TOKENS.put('refresh_token', tokens.refresh_token);
  return tokens.access_token;
}

async function handleInvoices(env) {
  const headers = corsHeaders(env);

  const accessToken = await getValidToken(env);
  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const tenantId = await env.TOKENS.get('tenant_id');

  const params = new URLSearchParams({
    order: 'Date DESC',
    page: '1',
    statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID',
  });

  const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices?${params}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(JSON.stringify({ error: 'xero_error', details: err }), {
      status: res.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const data = await res.json();

  // Return only the fields the frontend needs
  const invoices = (data.Invoices || []).slice(0, 20).map(inv => ({
    invoiceId: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber,
    reference: inv.Reference || '',
    status: inv.Status,
    contact: inv.Contact?.Name || '',
    date: inv.Date,
    lineItems: (inv.LineItems || []).map(li => ({
      description: li.Description || '',
      itemCode: li.ItemCode || '',
      quantity: li.Quantity,
      unitAmount: li.UnitAmount,
    })),
  }));

  return new Response(JSON.stringify({ invoices }), {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function handleInvoicePdf(invoiceId, env) {
  const headers = corsHeaders(env);

  const accessToken = await getValidToken(env);
  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const tenantId = await env.TOKENS.get('tenant_id');

  const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/pdf',
    },
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'pdf_fetch_failed' }), {
      status: res.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  return new Response(res.body, {
    headers: {
      ...headers,
      'Content-Type': 'application/pdf',
    },
  });
}

// --- Gmail OAuth ---

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

async function handleGmailCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing code', { status: 400 });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
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

async function getValidGmailToken(env) {
  let accessToken = await env.TOKENS.get('gmail_access_token');
  if (accessToken) return accessToken;

  const refreshToken = await env.TOKENS.get('gmail_refresh_token');
  if (!refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
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

async function handleGmailStatus(env) {
  const headers = corsHeaders(env);
  const token = await env.TOKENS.get('gmail_access_token');
  const refresh = await env.TOKENS.get('gmail_refresh_token');
  const connected = !!(token || refresh);
  return new Response(JSON.stringify({ connected }), {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// --- Gmail Draft Creation ---

async function handleGmailDraft(request, env) {
  const headers = corsHeaders(env);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  try {
    const { invoiceId, subject, hiringEntity, filename } = await request.json();

    if (!invoiceId || !subject || !filename) {
      return new Response(JSON.stringify({ error: 'Missing required fields: invoiceId, subject, filename' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // Validate invoiceId is a UUID
    if (!/^[a-f0-9-]+$/i.test(invoiceId)) {
      return new Response(JSON.stringify({ error: 'Invalid invoiceId' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // Get Gmail token
    const gmailToken = await getValidGmailToken(env);
    if (!gmailToken) {
      return new Response(JSON.stringify({ error: 'gmail_auth_required' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    // Get Xero token
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

    // Find last recipient
    const to = await findLastRecipient(gmailToken, hiringEntity);

    // Build MIME message
    const body = `Good Morning!\n\nI've attached my invoice for this one. Let me know if there's any issues in processing.\n\nThanks!\n\nEric`;
    const mimeMessage = buildMimeMessage({ to: to || '', subject, body, pdfBytes, pdfFilename: filename });

    // Base64url encode the MIME message
    const rawMessage = base64url(mimeMessage);

    // Create draft via Gmail API
    const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gmailToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: { raw: rawMessage } }),
    });

    if (!draftRes.ok) {
      const err = await draftRes.text();
      return new Response(JSON.stringify({ error: 'draft_creation_failed', details: err }), {
        status: 500, headers: jsonHeaders,
      });
    }

    const draft = await draftRes.json();
    return new Response(JSON.stringify({
      draftId: draft.id,
      messageId: draft.message.id,
      draftUrl: `https://mail.google.com/mail/u/0/#drafts/${draft.message.id}`,
    }), {
      headers: jsonHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'internal_error', details: err.message }), {
      status: 500, headers: jsonHeaders,
    });
  }
}

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

async function findLastRecipient(gmailToken, hiringEntity) {
  if (!hiringEntity) return null;

  try {
    const sanitized = hiringEntity.replace(/"/g, '');
    const query = `from:me subject:"Invoice for Labor" "${sanitized}" in:sent`;
    const params = new URLSearchParams({ q: query, maxResults: '1' });
    const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { 'Authorization': `Bearer ${gmailToken}` },
    });

    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    if (!searchData.messages || searchData.messages.length === 0) return null;

    const msgId = searchData.messages[0].id;
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=To`, {
      headers: { 'Authorization': `Bearer ${gmailToken}` },
    });

    if (!msgRes.ok) return null;

    const msgData = await msgRes.json();
    const toHeader = (msgData.payload?.headers || []).find(h => h.name.toLowerCase() === 'to');
    return toHeader?.value || null;
  } catch {
    return null;
  }
}

function buildMimeMessage({ to, subject, body, pdfBytes, pdfFilename }) {
  const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`;

  // Convert PDF ArrayBuffer to base64
  const pdfArray = new Uint8Array(pdfBytes);
  let binaryStr = '';
  for (let i = 0; i < pdfArray.length; i++) {
    binaryStr += String.fromCharCode(pdfArray[i]);
  }
  const pdfBase64 = btoa(binaryStr);

  // Split base64 into 76-char lines for MIME compliance
  const pdfBase64Lines = pdfBase64.match(/.{1,76}/g)?.join('\r\n') || '';

  const parts = [
    `MIME-Version: 1.0`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    pdfBase64Lines,
    `--${boundary}--`,
  ];

  return parts.join('\r\n');
}

function base64url(str) {
  // Use TextEncoder for binary-safe encoding (handles non-ASCII in subject/body)
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

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
