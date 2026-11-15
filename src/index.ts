import { Hono, type Context } from 'hono'
import { fieldLocations, getFieldTelemetry } from './earthdata'
type Bindings = { GOOGLE_MAPS_BROWSER_KEY?: string; NASA_EARTHDATA_TOKEN?: string }
const app = new Hono<{ Bindings: Bindings }>()
function getBindings(c: Context<{ Bindings: Bindings }>) {
  const processEnv = typeof process === 'undefined' ? undefined : process.env
  return {
    GOOGLE_MAPS_BROWSER_KEY: c.env?.GOOGLE_MAPS_BROWSER_KEY ?? processEnv?.GOOGLE_MAPS_BROWSER_KEY,
    NASA_EARTHDATA_TOKEN: c.env?.NASA_EARTHDATA_TOKEN ?? processEnv?.NASA_EARTHDATA_TOKEN,
  }
}
// Only known parcels are accepted; this is not an arbitrary NASA URL proxy.
app.get('/api/field-data', async c => {
  const field = fieldLocations.find(field => field.id === (c.req.query('field') ?? fieldLocations[0].id))
  if (!field) return c.json({ error: 'Unknown field' }, 400)
  const result = await getFieldTelemetry(field, getBindings(c).NASA_EARTHDATA_TOKEN)
  // Cache successful public observations briefly, never authentication or upstream URLs.
  const anyLive = Object.values(result.metrics).some(metric => metric.status === 'live')
  c.header('Cache-Control', anyLive ? 'private, max-age=300' : 'no-store')
  return c.json(result)
})
// Google browser keys are public by design: restrict this key by HTTP referrer
// and to Maps JavaScript API. Never use a server-side or unrestricted API key.
app.get('/api/maps/config', c => {
  c.header('Cache-Control', 'no-store')
  return c.json({ configured: Boolean(getBindings(c).GOOGLE_MAPS_BROWSER_KEY) })
})
app.get('/api/maps/loader', c => {
  c.header('Cache-Control', 'no-store')
  const key = getBindings(c).GOOGLE_MAPS_BROWSER_KEY
  if (!key) return c.text('Google Maps browser key is not configured', 503)
  const url = new URL('https://maps.googleapis.com/maps/api/js')
  url.searchParams.set('key', key)
  url.searchParams.set('callback', 'terraMapsReady')
  url.searchParams.set('loading', 'async')
  url.searchParams.set('v', 'weekly')
  return c.redirect(url.toString(), 302)
})
app.get('*', c => c.html(`<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta name="theme-color" content="#253f2e"/><meta name="description" content="Terra — your field, understood. Offline-first crop rotation planning and field intelligence."/><link rel="manifest" href="/manifest.webmanifest"/><link rel="icon" href="/icon.svg" type="image/svg+xml"/><title>Terra · Field intelligence</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;450;500;550;600;650;700&family=Manrope:wght@400;500;600;650;700;750;800&family=Noto+Sans+Gurmukhi:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&family=Noto+Sans+Kannada:wght@400;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/static/app.css"/></head><body><div id="root"></div><script type="module" src="/static/app.js"></script></body></html>`))
export default app
