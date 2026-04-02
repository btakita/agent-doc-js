// Cloudflare Worker — proxies Claude + Ragie API calls to bypass CORS
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization, anthropic-version, anthropic-dangerous-direct-browser-access',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    const url = new URL(request.url)

    // Route: Claude API
    if (request.method === 'POST' && url.pathname.startsWith('/v1/messages')) {
      return proxyClaudeWithRetry(request, env)
    }

    // Route: Ragie API
    if (request.method === 'POST' && url.pathname.startsWith('/ragie/')) {
      return proxyRagie(request, url, env)
    }

    return new Response('Not Found', { status: 404 })
  },
}

async function proxyClaudeWithRetry(request, env) {
  // Fall back to worker secret when client doesn't send a key
  const apiKey = request.headers.get('x-api-key') || env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'No API key provided and no server key configured' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  const maxRetries = 3
  let lastResponse

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
      },
      body: request.clone().body,
    })

    if (apiResponse.status !== 429 || apiResponse.headers.get('x-should-retry') !== 'true') {
      lastResponse = apiResponse
      break
    }

    lastResponse = apiResponse
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
    }
  }

  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  for (const h of ['retry-after', 'x-should-retry']) {
    const val = lastResponse.headers.get(h)
    if (val) headers.set(h, val)
  }

  return new Response(lastResponse.body, { status: lastResponse.status, headers })
}

async function proxyRagie(request, url, env) {
  // Fall back to worker secret when client doesn't send a key
  const authHeader = request.headers.get('Authorization')
  const ragieAuth = authHeader || (env.RAGIE_API_KEY ? `Bearer ${env.RAGIE_API_KEY}` : null)
  if (!ragieAuth) {
    return new Response(JSON.stringify({ error: 'No Ragie key provided and no server key configured' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  // Strip /ragie prefix -> forward to api.ragie.ai
  const ragiePath = url.pathname.replace(/^\/ragie/, '')
  const ragieUrl = `https://api.ragie.ai${ragiePath}`

  const apiResponse = await fetch(ragieUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': ragieAuth,
    },
    body: request.body,
  })

  return new Response(apiResponse.body, {
    status: apiResponse.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
