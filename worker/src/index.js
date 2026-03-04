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
    if (path === '/invoices') return handleInvoices(env, request);

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
    scope: 'openid profile email accounting.transactions.read offline_access',
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
function handleInvoices(env, request) { return new Response('TODO'); }
