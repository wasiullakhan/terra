import test from 'node:test'
import assert from 'node:assert/strict'
import { writeArrayBuffer } from 'geotiff'
import { getFieldTelemetry, fieldLocations, smapCell, asciiValue, nasaRequest } from './src/earthdata.ts'
import app from './src/index.tsx'

const originalFetch = globalThis.fetch
const field = fieldLocations[0]
const token = 'test-secret-not-a-real-token'
const signal = new AbortController().signal
const raster = value => writeArrayBuffer(new Float32Array([value]), { width: 1, height: 1, GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, ModelPixelScale: [.001, .001, 0], ModelTiepoint: [0, 0, 0, 75.8485, 30.9125, 0] })
function mockNasa({ moisture = .246, cloud = 0, water = 0, mask = 0, esi = .42, malformed = false } = {}) {
  globalThis.fetch = async (input, options) => {
    const url = new URL(input)
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`)
    assert.equal(options?.redirect, 'manual')
    if (url.hostname === 'cmr.earthdata.nasa.gov') {
      assert.equal(url.searchParams.get('point'), '75.849,30.912')
      assert.equal(url.searchParams.get('sort_key'), '-start_date')
      const name = url.searchParams.get('short_name')
      const suffixes = name === 'ECO_L4T_ESI' ? ['_cloud.tif', '_water.tif', '_ESI.tif'] : ['.Fmask.tif', '.B04.tif', '.B05.tif']
      const links = name === 'SPL4SMGP' ? [{ href: 'https://opendap.earthdata.nasa.gov/collections/test/granules/smap' }] : suffixes.map(suffix => ({ href: `https://data.lpdaac.earthdatacloud.nasa.gov/test${suffix}` }))
      return Response.json({ feed: { entry: [{ id: name, time_start: '2026-11-01T00:00:00Z', links }] } })
    }
    if (url.hostname === 'opendap.earthdata.nasa.gov') {
      assert.match(decodeURI(url.search), /sm_rootzone\[394\]\[2740\]/)
      return new Response(malformed ? 'Dataset { Float32 sm_rootzone[y=1624]; }' : `cell_lon[0], 75.8558\ncell_lat[0], 30.9251\n/Geophysical_Data/sm_rootzone[0], ${moisture}\n`)
    }
    const value = url.pathname.endsWith('_cloud.tif') ? cloud : url.pathname.endsWith('_water.tif') ? water : url.pathname.endsWith('_ESI.tif') ? esi : url.pathname.endsWith('.Fmask.tif') ? mask : url.pathname.endsWith('.B04.tif') ? 2000 : 6000
    const bytes = raster(value)
    const range = new Headers(options.headers).get('Range').match(/bytes=(\d+)-(\d+)/)
    const start = Number(range[1]), end = Math.min(Number(range[2]) + 1, bytes.byteLength)
    return new Response(bytes.slice(start, end), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.byteLength}`, 'Content-Type': 'image/tiff' } })
  }
}
test.afterEach(() => { globalThis.fetch = originalFetch })

test('SMAP coordinates and ASCII parsing use the measurement, not dimensions', () => {
  assert.deepEqual(smapCell(75.849, 30.912), { row: 394, column: 2740 })
  assert.equal(asciiValue('Dataset { Float32 x[1624][3856]; }\n/Geophysical_Data/sm_rootzone[0], 0.177335', '/Geophysical_Data/sm_rootzone'), .177335)
  assert.throws(() => asciiValue('Dataset [1624]', '/Geophysical_Data/sm_rootzone'))
})
test('live measurements, unit conversion, ESI and independent HLS NDVI', async () => {
  mockNasa()
  const result = await getFieldTelemetry(field, token)
  assert.equal(result.metrics.moisture.value, '24.6')
  assert.equal(result.metrics.moisture.status, 'live')
  assert.equal(result.metrics.stress.value, '0.42')
  assert.equal(result.metrics.stress.status, 'live')
  assert.equal(result.vegetation.value, '0.500')
  assert.equal(result.vegetation.units, 'NDVI')
  assert.equal(result.metrics.carbon.status, 'sample')
  assert.equal(result.metrics.carbon.value, '0.58')
  assert.equal(result.metrics.carbon.reason, 'hls_does_not_measure_soil_organic_carbon')
  assert.ok(!JSON.stringify(result).includes(token))
})
test('missing token produces original samples without upstream calls', async () => {
  globalThis.fetch = async () => { throw new Error('Must not fetch') }
  const result = await getFieldTelemetry(field)
  assert.equal(result.metrics.moisture.reason, 'token_not_configured')
  assert.equal(result.metrics.moisture.value, '24.6')
  assert.equal(result.metrics.stress.value, '0.32')
})
for (const status of [401, 403, 429, 500]) test(`NASA ${status} falls back safely`, async () => {
  globalThis.fetch = async () => new Response('Do not expose upstream body', { status })
  const result = await getFieldTelemetry(field, token)
  assert.equal(result.metrics.moisture.status, 'sample')
  assert.equal(result.metrics.stress.status, 'sample')
  assert.equal(result.metrics.moisture.value, '24.6')
  assert.equal(result.metrics.stress.value, '0.32')
  if (status === 429) assert.equal(result.metrics.moisture.reason, 'rate_limited')
  assert.ok(!JSON.stringify(result).includes('Do not expose'))
})
test('network timeouts fail independently with original fallback', async () => {
  globalThis.fetch = async () => { throw new DOMException('Timed out', 'TimeoutError') }
  const result = await getFieldTelemetry(field, token)
  assert.equal(result.metrics.moisture.reason, 'nasa_timeout')
})
test('fill values never become live percentages; other datasets can succeed', async () => {
  mockNasa({ moisture: -9999 })
  const result = await getFieldTelemetry(field, token)
  assert.equal(result.metrics.moisture.status, 'sample')
  assert.equal(result.metrics.stress.status, 'live')
})
test('cloud, water and HLS QA flags reject contaminated observations', async () => {
  mockNasa({ cloud: 1, mask: 8 })
  const result = await getFieldTelemetry(field, token)
  assert.equal(result.metrics.stress.status, 'sample')
  assert.equal(result.vegetation.status, 'sample')
  assert.equal(result.vegetation.value, null)
  assert.equal(result.metrics.moisture.status, 'live')
  mockNasa({ water: 1 })
  assert.equal((await getFieldTelemetry(field, token)).metrics.stress.status, 'sample')
})
test('malformed OPeNDAP does not turn dimensions into measurements', async () => {
  mockNasa({ malformed: true })
  assert.equal((await getFieldTelemetry(field, token)).metrics.moisture.status, 'sample')
})
test('redirects strip bearer credentials from NASA distribution hosts', async () => {
  let calls = 0
  globalThis.fetch = async (input, options) => {
    calls++
    const h = new Headers(options.headers)
    if (calls === 1) {
      assert.equal(h.get('Authorization'), `Bearer ${token}`)
      return new Response(null, { status: 303, headers: { Location: 'https://test.cloudfront.net/file.tif?signature=secret' } })
    }
    assert.equal(h.get('Authorization'), null)
    assert.equal(h.get('Range'), 'bytes=0-10')
    return new Response(new Uint8Array(11), { status: 206 })
  }
  assert.equal((await nasaRequest('https://data.lpdaac.earthdatacloud.nasa.gov/file', token, signal, { Range: 'bytes=0-10' })).status, 206)
  assert.equal(calls, 2)
})
test('untrusted data URLs and redirects are rejected', async () => {
  await assert.rejects(nasaRequest('https://evil.example/file', token, signal))
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/login' } })
  await assert.rejects(nasaRequest('https://opendap.earthdata.nasa.gov/file', token, signal))
})
test('API validates field identifiers and missing-token fallback headers', async () => {
  const invalid = await app.request('/api/field-data?field=https://evil.example', {}, {})
  assert.equal(invalid.status, 400)
  const response = await app.request('/api/field-data?field=PB-LDH-043', {}, {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.blockId, 'PB-LDH-043')
  assert.equal(body.metrics.moisture.value, '21.3')
})
