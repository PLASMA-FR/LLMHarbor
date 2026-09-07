import type { ConnectionInfo } from './contracts'

export function connectionBaseUrl(
  connection: ConnectionInfo | undefined,
  origin: string,
  basePath = '/',
  development = false,
): string {
  const browser = new URL(origin)
  if (!connection || (!connection.splitMode && !development))
    return browser.origin + basePath.replace(/\/$/, '') + '/v1'
  const listener = connection.publicApi
  const configured = listener.host.replace(/^\[(.*)\]$/, '$1')
  const hostname = ['0.0.0.0', '::', '127.0.0.1', 'localhost'].includes(configured)
    ? browser.hostname.replace(/^\[(.*)\]$/, '$1')
    : configured
  return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${listener.port}${listener.basePath}`
}

export function normalizeApiBase(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP(S) base URL without credentials, query parameters or a fragment.')
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '') || '/v1'
  return url.toString().replace(/\/$/, '')
}

export function integrationExample(language: 'curl' | 'javascript' | 'python', baseUrl: string): string {
  const quoted = JSON.stringify(baseUrl)
  if (language === 'javascript')
    return `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: ${quoted},\n  apiKey: process.env.LLMHARBOR_API_KEY,\n});\n\nconst response = await client.chat.completions.create({\n  model: 'auto',\n  messages: [{ role: 'user', content: 'Hello, Harbor!' }],\n});\n\nconsole.log(response.choices[0].message.content);`
  if (language === 'python')
    return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=${quoted},\n    api_key=os.environ["LLMHARBOR_API_KEY"],\n)\n\nresponse = client.chat.completions.create(\n    model="auto",\n    messages=[{"role": "user", "content": "Hello, Harbor!"}],\n)\n\nprint(response.choices[0].message.content)`
  const shellUrl = "'" + (baseUrl + '/chat/completions').replaceAll("'", "'\\''") + "'"
  return `curl ${shellUrl} \\\n  -H "Authorization: Bearer $LLMHARBOR_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{\n    "model": "auto",\n    "messages": [{"role": "user", "content": "Hello, Harbor!"}]\n  }'`
}
