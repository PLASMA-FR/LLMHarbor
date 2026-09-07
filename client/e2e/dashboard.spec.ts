import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page
    .getByRole('navigation', { name: 'Primary navigation', exact: true })
    .getByRole('link', { name, exact: true })
    .click()
}

test('all dashboard pages load on desktop and mobile without overflow or render errors', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [route, title] of [
      ['overview', 'Overview'],
      ['keys', 'Providers'],
      ['models', 'Models'],
      ['fallback', 'Routing'],
      ['oauth', 'OAuth accounts'],
      ['analytics', 'Analytics'],
      ['settings', 'Settings'],
      ['playground', 'Playground'],
      ['access', 'Client access'],
      ['api-guide', 'API & SDKs'],
    ]) {
      await page.goto(`/${route}`)
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
      await expect(page.getByText('Dashboard crashed before it could finish rendering.')).toHaveCount(0)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true)
    }
  }
  expect(errors).toEqual([])
})

test('Playground preserves the thread and draft on navigation, and exports a completed response', async ({
  page,
}) => {
  await page.goto('/playground')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello harbor')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Streaming reply ⚓.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent draft')
  await navigate(page, 'Models')
  await navigate(page, 'Playground')
  await expect(page.getByText('Streaming reply ⚓.', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Unsent draft')
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const download = await downloaded
  const stream = await download.createReadStream()
  let text = ''
  for await (const chunk of stream!) text += chunk.toString()
  const exported = JSON.parse(text)
  expect(exported.format).toBe('llmharbor.playground.v1')
  expect(exported.messages.at(-1).content).toBe('Streaming reply ⚓.')
  expect(exported.messages.at(-1).meta.requestId).toBeTruthy()
  await expect(page.getByRole('button', { name: 'Copy assistant response' })).toBeVisible()
})

test('Playground displays refusals and stops an in-progress response', async ({ page }) => {
  await page.goto('/playground')
  const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
  await prompt.fill('refuse')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('This is a simulated refusal.', { exact: true })).toBeVisible()
  await expect(prompt).toBeEnabled()
  await prompt.fill('slow')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Working…', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByText('Request stopped.', { exact: true })).toBeVisible()
  await expect(prompt).toBeEnabled()
})

test('Playground retries a failed request without duplicating the prompt and supports non-streaming', async ({
  page,
}, testInfo) => {
  await page.goto('/playground')
  const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
  const retryPrompt = `retry-once-${testInfo.project.name}-${testInfo.retry}`
  await prompt.fill(retryPrompt)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByRole('button', { name: 'Retry request' }).click()
  await expect(page.getByText('Streaming reply ⚓.', { exact: true })).toBeVisible()
  await expect(page.getByText(retryPrompt, { exact: true })).toHaveCount(1)
  await expect(prompt).toBeEnabled()
  await page.getByRole('switch', { name: 'Streaming', exact: true }).uncheck()
  await prompt.fill('single')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Single reply ⚓.', { exact: true })).toBeVisible()
})

test('model settings can be edited without removing the model or routing order', async ({
  page,
  request,
}) => {
  await page.goto('/models')
  await page.getByRole('button', { name: 'Edit Browser test model', exact: true }).click()
  const form = page.getByRole('form', { name: 'Edit Browser test model' })
  await form.getByLabel('Requests / minute', { exact: true }).fill('12')
  await form.getByLabel('Tokens / day', { exact: true }).fill('100000')
  await form.getByRole('button', { name: 'Save model' }).click()
  await expect(form).toHaveCount(0)
  await page.evaluate(() => window.scrollTo(0, 600))
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Overview', exact: true }),
  ).toBeInViewport()
  await navigate(page, 'Overview')
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeInViewport()
  const models = await (await request.get('/api/endpoints/custom-browser/models')).json()
  const model = models.find((model: { modelId: string }) => model.modelId === 'fixture-model')
  expect(model).toMatchObject({ rpmLimit: 12, tpdLimit: 100000, contextWindow: 8192, fallbackEnabled: true })
  await request.patch(`/api/providers/custom-browser/models/${model.id}`, {
    data: { rpmLimit: null, tpdLimit: null },
  })
})

test('client keys are created and rotated with explicit one-time secret handling', async ({
  page,
  request,
}) => {
  await page.goto('/access?create=1')
  const create = page.getByRole('dialog', { name: 'New client key', exact: true })
  await create.getByLabel('Name', { exact: true }).fill('Browser app')
  await create.getByRole('button', { name: 'Create client key', exact: true }).click()
  const secretDialog = page.getByRole('dialog', { name: 'Save your client key', exact: true })
  await expect(secretDialog).toBeVisible()
  const original = await secretDialog.getByLabel('Client API key', { exact: true }).textContent()
  expect(original).toMatch(/^llmharbor-/)
  await page.keyboard.press('Escape')
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('Have you saved this key?')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(secretDialog).toBeVisible()
  await secretDialog.getByRole('button', { name: 'I saved this key' }).click()
  const keyId = new URL(page.url()).searchParams.get('key')!
  await page.getByRole('button', { name: 'Rotate', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key', exact: true }).click()
  await expect(secretDialog).toBeVisible()
  await expect(secretDialog.getByLabel('Client API key', { exact: true })).not.toHaveText(original!)
  await secretDialog.getByRole('button', { name: 'I saved this key' }).click()
  await expect(page.getByText(original!, { exact: true })).toHaveCount(0)
  await request.delete(`/api/client-keys/${keyId}`)
})

test('policy browsing is paged and edits the selected client only', async ({ page, request }) => {
  const key = await (await request.post('/api/client-keys', { data: { label: 'Policy test' } })).json()
  await page.goto(`/access?key=${key.id}`)
  await page
    .getByRole('navigation', { name: 'Policy scope' })
    .getByRole('button', { name: /^Models/ })
    .click()
  const switches = page.getByRole('switch', { name: /^(Block|Allow) model / })
  await expect(switches).toHaveCount(15)
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('16–30')
  await page.getByRole('searchbox', { name: 'Search model policies' }).fill('Policy model 174')
  await page.getByRole('switch', { name: 'Block model Policy model 174', exact: true }).click()
  await expect(
    page.getByRole('switch', { name: 'Allow model Policy model 174', exact: true }),
  ).not.toBeChecked()
  const policy = await (await request.get(`/api/client-keys/${key.id}/access-policy`)).json()
  expect(policy.models.find((model: { modelId: string }) => model.modelId === 'policy-174').enabled).toBe(
    false,
  )
  await request.delete(`/api/client-keys/${key.id}`)
})

test('custom endpoint setup works without a dummy API key and leads to a usable route', async ({
  page,
  request,
}) => {
  const providers = await (await request.get('/api/providers')).json()
  const baseUrl = providers.find(
    (provider: { platform: string }) => provider.platform === 'custom-browser',
  ).baseUrl
  await page.goto('/providers')
  await page.getByRole('button', { name: 'Custom endpoint', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect a custom endpoint', exact: true })
  await dialog.getByLabel('Name', { exact: true }).fill('Local UI fixture')
  await dialog.getByLabel('Base URL', { exact: true }).fill(baseUrl)
  await dialog.getByRole('button', { name: 'Connect endpoint', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const platform = new URL(page.url()).searchParams.get('provider')!
  const credentials = await (await request.get('/api/provider-keys')).json()
  expect(credentials.find((key: { platform: string }) => key.platform === platform).source).toBe('anonymous')
  await page
    .getByRole('row')
    .filter({ hasText: 'Local UI fixture' })
    .getByText('Models', { exact: true })
    .click()
  await page.getByRole('button', { name: 'Register model', exact: true }).click()
  const register = page.getByRole('dialog', { name: 'Register a model' })
  await register.getByLabel('Model ID', { exact: true }).fill('local-ui-model')
  await register.getByRole('button', { name: 'Register model', exact: true }).click()
  await expect(register).toHaveCount(0)
  await page.getByRole('button', { name: 'Test local-ui-model', exact: true }).click()
  const probe = page.getByRole('dialog', { name: 'Model probe' })
  await expect(probe).toContainText('Probe passed')
  await probe.getByRole('button', { name: 'Enable this route', exact: true }).click()
  if (await probe.isVisible()) await probe.getByRole('button', { name: 'Close Model probe' }).click()
  await expect(page.getByRole('switch', { name: 'Disable routing for local-ui-model' })).toBeChecked()
  await request.delete(`/api/providers/${platform}`)
})

test('routing drafts survive cancelled navigation and detect concurrent edits', async ({ page, request }) => {
  const routes = await (await request.get('/api/routing')).json()
  const model = routes.find((route: { modelId: string }) => route.modelId === 'fixture-model')
  await page.goto('/fallback')
  await page.getByRole('searchbox', { name: 'Search routing models' }).fill('Browser test model')
  await page.getByRole('switch', { name: 'Disable Browser test model in routing', exact: true }).click()
  await navigate(page, 'Providers')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(/\/fallback/)
  await expect(page.getByText('Unsaved routing changes', { exact: true })).toBeVisible()
  await request.patch(`/api/routing/models/${model.modelDbId}`, { data: { enabled: false } })
  await page.getByRole('button', { name: 'Save order', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Reload current order', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reload current order', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Reload current order', exact: true })
    .click()
  await expect(page.getByText('Unsaved routing changes', { exact: true })).toHaveCount(0)
  await request.patch(`/api/routing/models/${model.modelDbId}`, { data: { enabled: true } })
})

test('request history finds a correlation ID and shows its trace', async ({ page, request }) => {
  const id = `ui-trace-${Date.now()}`
  const completion = await request.post('/api/playground/v1/chat/completions', {
    headers: { 'X-Request-Id': id },
    data: { messages: [{ role: 'user', content: 'Trace this' }] },
  })
  expect(completion.ok()).toBe(true)
  await page.goto(`/analytics?view=requests&q=${id}`)
  await page.getByRole('button', { name: /^Inspect request / }).click()
  const trace = page.getByRole('dialog', { name: 'Request trace' })
  await expect(trace.getByLabel('Request ID', { exact: true })).toHaveText(id)
  await expect(trace).toContainText('Final result')
  await expect(trace).toContainText('custom-browser/fixture-model')
})

test('API guide generates correct examples and downloads the contract', async ({ page }) => {
  await page.goto('/api-guide')
  await page
    .getByRole('navigation', { name: 'Example language' })
    .getByRole('button', { name: 'JavaScript', exact: true })
    .click()
  await page
    .getByLabel('API base URL', { exact: true })
    .fill('https://gateway.example/harbor/v1/chat/completions')
  await expect(page.getByLabel('JavaScript example', { exact: true })).toContainText(
    'baseURL: "https://gateway.example/harbor/v1"',
  )
  await expect(page.getByLabel('JavaScript example', { exact: true })).toContainText(
    'process.env.LLMHARBOR_API_KEY',
  )
  const downloaded = page.waitForEvent('download')
  await page.getByText('OpenAPI contract', { exact: true }).click()
  const stream = await (await downloaded).createReadStream()
  let content = ''
  for await (const chunk of stream!) content += chunk.toString()
  expect(JSON.parse(content).paths['/api/client-keys']).toBeTruthy()
})

test('page finder supports keyboard search, escape and focus restoration', async ({ page }) => {
  await page.goto('/overview')
  await page.getByRole('button', { name: 'Search dashboard' }).focus()
  await page.keyboard.press('Control+k')
  const finder = page.getByRole('dialog', { name: 'Find your way around' })
  await expect(finder.getByRole('searchbox', { name: 'Search pages' })).toBeFocused()
  await page.keyboard.type('client')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Client access', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Search dashboard' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Search dashboard' })).toBeFocused()
})

test('Markdown preview renders code without fetching remote images and preserves plain text', async ({
  page,
}) => {
  let imageRequested = false
  page.on('request', (request) => {
    if (request.url().includes('/fixture-image')) imageRequested = true
  })
  await page.goto('/playground')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('markdown')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.markdown-content strong')).toHaveText('Formatted reply')
  await expect(page.getByLabel('Code · js', { exact: true })).toContainText('const total = 1;')
  expect(imageRequested).toBe(false)
  await page.getByRole('button', { name: 'Markdown preview', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('**Formatted reply**')
})

test('a connection failure leaves the form usable instead of queuing an invisible save', async ({
  page,
  context,
}) => {
  await page.goto('/access?create=1')
  const dialog = page.getByRole('dialog', { name: 'New client key', exact: true })
  await dialog.getByLabel('Name', { exact: true }).fill('Offline app')
  await context.setOffline(true)
  try {
    await dialog.getByRole('button', { name: 'Create client key', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Could not reach LLMHarbor')
    await expect(dialog.getByRole('button', { name: 'Create client key', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Close New client key', exact: true }).click()
  } finally {
    await context.setOffline(false)
  }
})

test('core pages meet automated accessibility checks in both themes', async ({ page }) => {
  test.setTimeout(180_000)
  for (const dark of [false, true]) {
    await page.goto('/overview')
    const toggle = page.getByRole('button', { name: 'Dark theme', exact: true })
    if ((await toggle.getAttribute('aria-pressed')) !== String(dark)) await toggle.click()
    for (const route of [
      '/overview',
      '/providers',
      '/models',
      '/fallback',
      '/oauth',
      '/access',
      '/api-guide',
      '/settings',
      '/settings?section=backup',
      '/analytics?view=requests',
    ]) {
      await page.goto(route)
      await expect(page.locator('main h1')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(
        results.violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target),
        })),
        route + (dark ? ' dark' : ' light'),
      ).toEqual([])
    }
  }
})

test.describe('touch layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('navigation drawer and forms work on a narrow touch screen', async ({ page }) => {
    await page.goto('/overview')
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible()
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Providers', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'Providers', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Custom endpoint', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connect a custom endpoint' })
    await expect(dialog).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    expect(
      await dialog
        .getByLabel('Base URL', { exact: true })
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe('16px')
    await dialog.getByRole('button', { name: 'Close Connect a custom endpoint' }).click()
    await expect(page.getByRole('button', { name: 'Custom endpoint', exact: true })).toBeFocused()
  })
})
