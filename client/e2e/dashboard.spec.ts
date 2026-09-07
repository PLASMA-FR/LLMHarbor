import { expect, test } from '@playwright/test'

test('all dashboard pages load on desktop and mobile without overflow or render errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [route, title] of [
      ['overview', 'Overview'], ['keys', 'Providers & keys'], ['models', 'Models'],
      ['fallback', 'Routing'], ['oauth', 'OAuth accounts'], ['analytics', 'Analytics'],
      ['settings', 'Local API access controls'], ['playground', 'Playground'],
    ]) {
      await page.goto(`/${route}`)
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
      await expect(page.getByText('Dashboard crashed before it could finish rendering.')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
  expect(errors).toEqual([])
})

test('Playground preserves the thread and draft on navigation, and exports a completed response', async ({ page }) => {
  await page.goto('/playground')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello harbor')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Streaming reply ⚓.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent draft')
  await page.getByRole('link', { name: 'Models catalog' }).click()
  await page.getByRole('link', { name: 'Playground test requests' }).click()
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

test('Playground retries a failed request without duplicating the prompt and supports non-streaming', async ({ page }, testInfo) => {
  await page.goto('/playground')
  const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
  const retryPrompt = `retry-once-${testInfo.retry}`
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

test('model settings can be edited without removing the model or routing order', async ({ page, request }) => {
  await page.goto('/models')
  await page.getByRole('button', { name: 'Edit Browser test model', exact: true }).click()
  const form = page.getByRole('form', { name: 'Edit Browser test model' })
  await form.getByLabel('Requests / minute', { exact: true }).fill('12')
  await form.getByLabel('Tokens / day', { exact: true }).fill('100000')
  await form.getByRole('button', { name: 'Save model' }).click()
  await expect(form).toHaveCount(0)
  await page.evaluate(() => window.scrollTo(0, 600))
  await expect(page.getByRole('link', { name: 'Overview service health' })).toBeInViewport()
  await page.getByRole('link', { name: 'Overview service health' }).click()
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeInViewport()
  const models = await (await request.get('/api/endpoints/custom-browser/models')).json()
  expect(models.find((model: { modelId: string }) => model.modelId === 'fixture-model'))
    .toMatchObject({ rpmLimit: 12, tpdLimit: 100000, contextWindow: 8192, fallbackEnabled: true, priority: 1000 })
})

test('model policy browsing reaches entries after the first page', async ({ page }) => {
  await page.goto('/settings')
  const modelSwitches = page.getByRole('switch', { name: /^(Block|Allow) model / })
  await expect(modelSwitches).toHaveCount(160)
  await page.getByRole('button', { name: /Show more models/ }).click()
  await expect.poll(() => modelSwitches.count()).toBeGreaterThan(160)
  await page.getByLabel('Search', { exact: true }).fill('Policy model 174')
  await expect(page.getByRole('switch', { name: 'Block model Policy model 174', exact: true })).toBeVisible()
  await page.getByRole('switch', { name: 'Block model Policy model 174', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Allow model Policy model 174', exact: true })).toBeChecked({ checked: false })
})
