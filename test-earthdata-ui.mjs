import { chromium, expect } from '@playwright/test'

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
let mode = 'live', requests = 0
const result = field => ({ blockId: field, fetchedAt: '2026-11-15T00:00:00Z', metrics: {
  moisture: { status: 'live', value: field === 'PB-LDH-043' ? '19.2' : '17.7', source: 'SMAP', observedAt: '2026-11-10T21:00:00Z' },
  carbon: { status: 'sample', value: field === 'PB-LDH-043' ? '0.49' : '0.58', source: 'HLS baseline', reason: 'hls_does_not_measure_soil_organic_carbon' },
  stress: { status: 'live', value: '0.94', source: 'ECOSTRESS', observedAt: '2026-10-19T06:23:40Z' },
} })
await context.route('**/api/field-data?*', async route => {
  requests++
  const field = new URL(route.request().url()).searchParams.get('field')
  const currentMode = mode
  await new Promise(resolve => setTimeout(resolve, currentMode === 'slow' ? 1600 : 350))
  if (currentMode === 'failure') return route.fulfill({ status: 429, body: 'Rate limited' })
  if (currentMode === 'malformed') return route.fulfill({ json: { ...result(field), metrics: { ...result(field).metrics, moisture: { status: 'live', value: 'NaN' } } } })
  if (currentMode === 'partial') return route.fulfill({ json: { ...result(field), metrics: { ...result(field).metrics, stress: { status: 'sample', value: '0.32', reason: 'rate_limited', source: 'ECOSTRESS' } } } })
  return route.fulfill({ json: result(field) })
})
try {
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.telemetry-grid')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.metric-value').first()).toContainText('…')
  await expect(page.locator('.field-footnote')).toContainText('Loading NASA')
  await expect(page.locator('.telemetry-grid')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.metric-value').nth(0)).toContainText('17.7')
  await expect(page.locator('.metric-value').nth(1)).toContainText('0.58')
  await expect(page.locator('.metric-value').nth(2)).toContainText('0.94')
  await expect(page.locator('.telemetry-card').nth(1)).toContainText('Sample baseline')
  await expect(page.locator('.field-footnote')).toContainText('sample carbon')
  // Preserve the supplied element hierarchy and classes: no skeleton wrappers.
  expect(await page.locator('.telemetry-card').first().evaluate(el => [...el.children].map(child => child.className))).toEqual(['metric-label', 'metric-value', 'metric-status'])
  expect(await page.locator('.telemetry-card').count()).toBe(3)
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  mode = 'partial'; await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.telemetry-grid')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.metric-value').first()).toContainText('17.7')
  await expect(page.locator('.metric-value').last()).toContainText('0.32')
  await expect(page.locator('.telemetry-card').last()).toContainText('Sample baseline')
  for (const value of ['failure', 'malformed']) {
    mode = value; await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.telemetry-grid')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.metric-value').first()).toContainText('24.6')
    await expect(page.locator('.field-footnote')).toContainText('Sample dataset')
  }
  mode = 'slow'; await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.telemetry-grid')).toHaveAttribute('aria-busy', 'true')
  await page.getByRole('button', { name: 'Change field', exact: true }).click()
  mode = 'live'
  await page.getByRole('button', { name: /East field/ }).click()
  await expect(page.locator('.telemetry-grid')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.metric-value').first()).toContainText('19.2')
  await page.waitForTimeout(1700)
  await expect(page.locator('.metric-value').first()).toContainText('19.2')
  await context.setOffline(true)
  await expect(page.locator('.metric-value').first()).toContainText('21.3')
  await expect(page.locator('.field-footnote')).toContainText('Sample dataset')
  const beforeReconnect = requests
  await context.setOffline(false)
  await expect(page.locator('.metric-value').first()).toContainText('19.2')
  expect(requests).toBeGreaterThan(beforeReconnect)
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.frameLocator('.report-preview').locator('body')).toContainText('19.2%')
  await expect(page.frameLocator('.report-preview').locator('body')).toContainText('carbon: sample')
  await expect(page.frameLocator('.report-preview').locator('body')).toContainText('2026-11-10')
  expect(errors).toEqual([])
  console.log('PASS: NASA loading, live, partial, rate-limit and malformed-response fallbacks; unchanged card hierarchy; responsive widths; stale-request cancellation; offline/reconnect; report provenance; no JavaScript errors.')
} finally { await browser.close() }
