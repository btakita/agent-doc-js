// Cloudflare Worker — proxies Claude API calls to bypass CORS restrictions
export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // Only proxy POST to /v1/messages
    const url = new URL(request.url)
    if (request.method !== 'POST' || !url.pathname.startsWith('/v1/messages')) {
      return new Response('Not Found', { status: 404 })
    }

    // Forward to Anthropic API
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': request.headers.get('x-api-key'),
        'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
      },
      body: request.body,
    })

    // Return with CORS headers
    const response = new Response(apiResponse.body, {
      status: apiResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
    return response
  },
}
