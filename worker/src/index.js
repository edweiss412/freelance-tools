export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (path === '/auth') return handleAuth(env);
    if (path === '/callback') return handleCallback(url, env);
    if (path === '/invoices') return handleInvoices(env);

    return new Response('Not found', { status: 404 });
  }
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
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
