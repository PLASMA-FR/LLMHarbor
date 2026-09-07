import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { ArrowRight, Download, KeyRound, Code2 } from 'lucide-react'
import type { ConnectionInfo } from '@/lib/contracts'
import { apiFetch, apiUrl } from '@/lib/api'
import { connectionBaseUrl, integrationExample, normalizeApiBase } from '@/lib/connection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader, SectionTitle, LoadingState } from '@/components/page-header'
import { ErrorNotice } from '@/components/error-notice'
import { CodeBlock } from '@/components/code-block'
import { SectionTabs } from '@/components/section-tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const resources = [
  ['GET', '/v1/models', 'List models available to your client key.'],
  ['POST', '/v1/chat/completions', 'Create a text completion, streamed response or function call.'],
  ['GET', '/api/providers', 'Inspect provider connections and available credentials.'],
  ['GET / POST', '/api/client-keys', 'List app keys or create a secret shown once.'],
  ['PATCH', '/api/client-keys/{id}/access-policy', 'Control route, provider and model access.'],
  ['POST', '/api/client-keys/{id}/rotate', 'Replace a secret while retaining quotas and policy.'],
  ['GET / PUT', '/api/routing', 'Read or save the model order. Use If-Match to detect conflicts.'],
  ['GET', '/api/requests?limit=25', 'Page through request history with nextCursor.'],
  ['GET', '/api/requests/{id}', 'Inspect a routed request and its fallback trace.'],
]
const errors = [
  ['400', 'Invalid request', 'Read error.param and error.details for the fields to fix.'],
  ['401', 'Authentication', 'Send an enabled client key in Authorization: Bearer <key>.'],
  [
    '403',
    'Access denied',
    'Check this key’s allowed routes, providers and models. Dashboard APIs also require local/private access.',
  ],
  ['409', 'Conflict', 'Refresh the resource before retrying an edit, or resolve a duplicate.'],
  ['429', 'Rate limit', 'Wait before retrying. Respect Retry-After when supplied.'],
  [
    '502 / 503 / 504',
    'Upstream unavailable',
    'Check provider credentials, route availability and request traces.',
  ],
]

export default function ApiGuidePage() {
  const [language, setLanguage] = useState<'curl' | 'javascript' | 'python'>('curl')
  const [override, setOverride] = useState<string | null>(null)
  const connection = useQuery<ConnectionInfo>({
    queryKey: ['connection-info'],
    queryFn: ({ signal }) => apiFetch('/api/settings/connection', { signal }),
  })
  const base =
    override ??
    connectionBaseUrl(connection.data, window.location.origin, import.meta.env.BASE_URL, import.meta.env.DEV)
  let url = ''
  let urlError = ''
  try {
    url = normalizeApiBase(base)
  } catch (error) {
    urlError = error instanceof Error ? error.message : 'Enter a valid base URL.'
  }
  return (
    <div>
      <PageHeader
        title="API & SDKs"
        description="One client key and one base URL connect your app to every eligible model."
        actions={
          <Button
            variant="outline"
            render={<a href={apiUrl('/api/openapi.json')} download="llmharbor-openapi.json" />}
          >
            <Download aria-hidden="true" />
            OpenAPI contract
          </Button>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-6">
          <section className="panel-card rounded-xl p-5">
            <SectionTitle
              title="Connect your app"
              description="Use the official OpenAI SDK or any HTTP client."
            />
            <div className="mb-5 space-y-2">
              <Label htmlFor="integration-base">API base URL</Label>
              <Input
                id="integration-base"
                type="url"
                value={base}
                onChange={(event) => setOverride(event.target.value)}
                aria-invalid={Boolean(urlError)}
                aria-describedby="integration-base-help"
                className="font-mono text-sm"
              />
              <p
                id="integration-base-help"
                className={urlError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
              >
                {urlError || 'Use the address your app can reach. Editing this updates examples only.'}
              </p>
            </div>
            <SectionTabs
              label="Example language"
              value={language}
              onChange={setLanguage}
              items={[
                { value: 'curl', label: 'cURL' },
                { value: 'javascript', label: 'JavaScript' },
                { value: 'python', label: 'Python' },
              ]}
            />
            <div className="mt-4">
              {connection.isLoading ? (
                <LoadingState title="Reading connection settings" />
              ) : urlError ? (
                <p className="text-sm text-muted-foreground">Enter a valid URL to generate an example.</p>
              ) : (
                <CodeBlock
                  code={integrationExample(language, url)}
                  label={`${language === 'curl' ? 'cURL' : language === 'javascript' ? 'JavaScript' : 'Python'} example`}
                />
              )}
            </div>
            <div className="mt-4">
              <ErrorNotice error={connection.error} />
            </div>
            <p className="mt-4 text-xs leading-6 text-muted-foreground">
              Set <code>LLMHARBOR_API_KEY</code> in your app’s environment to a key from{' '}
              <NavLink to="/access" className="text-primary underline">
                Client access
              </NavLink>
              . JavaScript: <code>npm install openai</code>. Python: <code>pip install openai</code>.
            </p>
          </section>
          <section className="panel-card rounded-xl p-5">
            <SectionTitle title="Models, streaming and tools" />
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium">Let the router choose</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Use <code>model: "auto"</code> or omit model. For a preferred model, copy its{' '}
                  <code>provider/model</code> ID from <code>GET /v1/models</code>. Retryable failures may use
                  another eligible route.
                </p>
              </div>
              <div>
                <h3 className="text-sm font-medium">Read a stream safely</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Set <code>stream: true</code>. Events end with <code>data: [DONE]</code>. Request{' '}
                  <code>stream_options.include_usage</code> for a final usage frame with empty choices. Handle
                  error frames as an interrupted response.
                </p>
              </div>
            </div>
            <p className="mt-5 border-t border-border pt-4 text-sm leading-6 text-muted-foreground">
              Text messages, developer instructions, function tools and refusals are supported. Set either{' '}
              <code>max_tokens</code> or <code>max_completion_tokens</code>. Image/audio input, JSON-schema
              output and multiple completions are not supported. Other unrecognized fields are listed in{' '}
              <code>X-LLMHarbor-Ignored-Parameters</code>.
            </p>
          </section>
          <section className="panel-card overflow-hidden rounded-xl">
            <div className="p-5">
              <SectionTitle
                title="API reference"
                description="The /v1 inference API uses client Bearer keys. The /api control plane uses the dashboard’s local/private network boundary."
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Method</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead className="pr-5">Purpose</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resources.map(([method, path, description]) => (
                  <TableRow key={path}>
                    <TableCell className="whitespace-nowrap pl-5 font-mono text-[11px] text-primary">
                      {method}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{path}</TableCell>
                    <TableCell className="pr-5 text-xs leading-5 text-muted-foreground">
                      {description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="p-5 text-xs leading-6 text-muted-foreground">
              Existing paths such as <code>/api/keys</code>, <code>/api/endpoints</code>,{' '}
              <code>/api/settings/api-keys</code> and <code>/api/fallback</code> remain supported. Collection
              pagination is opt-in for keys: add <code>limit</code> to receive a <code>data</code> and{' '}
              <code>pagination</code> envelope. PATCH preserves omitted fields; <code>null</code> clears a
              quota.
            </p>
          </section>
          <section id="errors" className="panel-card scroll-mt-24 overflow-hidden rounded-xl">
            <div className="p-5">
              <SectionTitle
                title="Diagnose a request"
                description="Errors include a stable code, field details when relevant, and the same request ID as the X-Request-Id header."
              />
              <CodeBlock
                label="Validation error"
                code={JSON.stringify(
                  {
                    error: {
                      message: 'Invalid request. max_tokens: Number must be greater than 0',
                      type: 'invalid_request_error',
                      code: 'validation_error',
                      param: 'max_tokens',
                      request_id: 'your-request-id',
                      details: [
                        { path: 'max_tokens', code: 'too_small', message: 'Number must be greater than 0' },
                      ],
                    },
                  },
                  null,
                  2,
                )}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Status</TableHead>
                  <TableHead>Meaning</TableHead>
                  <TableHead className="pr-5">Next step</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map(([status, meaning, action]) => (
                  <TableRow key={status}>
                    <TableCell className="whitespace-nowrap pl-5 font-mono text-xs">{status}</TableCell>
                    <TableCell className="text-sm">{meaning}</TableCell>
                    <TableCell className="pr-5 text-xs leading-5 text-muted-foreground">{action}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </div>
        <aside className="space-y-4 xl:sticky xl:top-24" aria-label="Integration checklist">
          <div className="panel-card rounded-xl p-5">
            <KeyRound className="mb-3 size-5 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Your first integration</h2>
            <ol className="mt-4 space-y-4 text-sm">
              <li>
                <span className="text-muted-foreground">1. </span>
                <NavLink to="/providers" className="hover:text-primary">
                  Connect a provider
                </NavLink>
              </li>
              <li>
                <span className="text-muted-foreground">2. </span>
                <NavLink to="/access?create=1" className="hover:text-primary">
                  Create and save a client key
                </NavLink>
              </li>
              <li>
                <span className="text-muted-foreground">3. </span>
                <NavLink to="/playground" className="hover:text-primary">
                  Verify a Playground request
                </NavLink>
              </li>
              <li>
                <span className="text-muted-foreground">4. </span>Copy an SDK example
              </li>
            </ol>
            <Button className="mt-5 w-full" render={<NavLink to="/playground" />}>
              Try Playground
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          <div className="rounded-xl border border-border p-5">
            <Code2 className="mb-3 size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs leading-6 text-muted-foreground">
              Routed requests appear in Analytics → Request history. Inspect the final outcome and each
              fallback event. Prompts and responses are not stored in request history.
            </p>
            <NavLink to="/analytics?view=requests" className="mt-3 inline-flex text-sm text-primary">
              Open request history →
            </NavLink>
          </div>
        </aside>
      </div>
    </div>
  )
}
