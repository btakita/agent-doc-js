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

    // Retry logic for transient rate limits
    const maxRetries = 3
    let lastResponse

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': request.headers.get('x-api-key'),
          'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
        },
        body: request.clone().body,
      })

      // If not a retryable rate limit, return immediately
      if (apiResponse.status !== 429 || apiResponse.headers.get('x-should-retry') !== 'true') {
        lastResponse = apiResponse
        break
      }

      lastResponse = apiResponse

      // Wait before retry (exponential backoff: 1s, 2s, 4s)
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
      }
    }

    // Forward response with CORS headers + rate limit info
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })

    // Forward useful headers from Anthropic
    for (const h of ['retry-after', 'x-should-retry', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests']) {
      const val = lastResponse.headers.get(h)
      if (val) headers.set(h, val)
    }

    return new Response(lastResponse.body, {
      status: lastResponse.status,
      headers,
    })
  },
}
