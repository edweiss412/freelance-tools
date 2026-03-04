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

function handleAuth(env) { return new Response('TODO'); }
function handleCallback(url, env) { return new Response('TODO'); }
function handleInvoices(env, request) { return new Response('TODO'); }
