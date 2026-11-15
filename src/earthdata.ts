import { fromCustomClient } from 'geotiff'
import proj4 from 'proj4'

// Coordinates are [longitude, latitude], matching the existing demonstration parcels.
export const fieldLocations = [
  { id: 'PB-LDH-042', longitude: 75.849, latitude: 30.912, moisture: '24.6', carbon: '0.58', stress: '0.32' },
  { id: 'PB-LDH-043', longitude: 75.854, latitude: 30.913, moisture: '21.3', carbon: '0.49', stress: '0.38' },
  { id: 'PB-LDH-044', longitude: 75.850, latitude: 30.908, moisture: '26.1', carbon: '0.63', stress: '0.28' },
] as const
export type FieldLocation = typeof fieldLocations[number]
type Granule = { id: string; time_start: string; links: { href: string; inherited?: boolean }[] }
type Observation = { value: number; observedAt: string; granuleId: string; source: string; units: string }
export type MetricResult = { status: 'live' | 'sample'; value: string; observedAt?: string; granuleId?: string; source: string; reason?: string }
class DataError extends Error { constructor(public code: string) { super(code) } }
const allowedHosts = new Set(['cmr.earthdata.nasa.gov', 'opendap.earthdata.nasa.gov', 'data.lpdaac.earthdatacloud.nasa.gov'])
function safeUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password) throw new DataError('invalid_data_url')
  return url.toString()
}
export async function nasaRequest(url: string, token: string, signal: AbortSignal, rangeHeaders?: HeadersInit) {
  let target = safeUrl(url)
  for (let redirect = 0; redirect < 5; redirect++) {
    const parsed = new URL(target)
    const requestHeaders = new Headers(rangeHeaders)
    // Workers forward Authorization across automatic redirects. Follow manually,
    // sending the Earthdata bearer only to the explicitly trusted NASA hosts.
    if (allowedHosts.has(parsed.hostname)) requestHeaders.set('Authorization', `Bearer ${token}`)
    else requestHeaders.delete('Authorization')
    const response = await fetch(target, { headers: requestHeaders, signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('Location')
    await response.body?.cancel()
    if (!location) throw new DataError('earthdata_access_denied')
    const next = new URL(location, target)
    const distribution = next.hostname.endsWith('.cloudfront.net') || next.hostname.endsWith('.s3.us-west-2.amazonaws.com') || next.hostname.endsWith('.s3.amazonaws.com')
    if (next.protocol !== 'https:' || next.username || next.password || (!allowedHosts.has(next.hostname) && !distribution)) throw new DataError('earthdata_access_denied')
    target = next.toString()
  }
  throw new DataError('too_many_redirects')
}
async function nasaFetch(url: string, token: string, signal: AbortSignal) {
  const response = await nasaRequest(url, token, signal)
  if (!response.ok) {
    await response.body?.cancel()
    throw new DataError(response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'earthdata_access_denied' : 'nasa_unavailable')
  }
  if (response.headers.get('Content-Type')?.includes('text/html')) throw new DataError('earthdata_access_denied')
  return response
}
async function discover(shortName: string, version: string, field: FieldLocation, token: string, signal: AbortSignal) {
  const url = new URL('https://cmr.earthdata.nasa.gov/search/granules.json')
  url.search = new URLSearchParams({ short_name: shortName, version, point: `${field.longitude},${field.latitude}`, page_size: '2', sort_key: '-start_date', temporal: `${new Date(Date.now() - 90 * 86400000).toISOString()},${new Date().toISOString()}` }).toString()
  const data = await (await nasaFetch(url.toString(), token, signal)).json() as { feed?: { entry?: Granule[] } }
  const entries = data.feed?.entry
  if (!Array.isArray(entries) || !entries.length) throw new DataError('no_recent_coverage')
  return entries
}
export function smapCell(longitude: number, latitude: number) {
  // EPSG:6933 / NSIDC EASE-Grid 2.0, M09 global dimensions 3856 x 1624.
  const [x, y] = proj4('EPSG:4326', '+proj=cea +lat_ts=30 +lon_0=0 +datum=WGS84 +units=m', [longitude, latitude])
  const column = Math.floor((x + 17367530.4451615) / 9008.055210146)
  const row = Math.floor((7314540.8306386 - y) / 9008.055210146)
  if (row < 0 || row >= 1624 || column < 0 || column >= 3856) throw new DataError('outside_grid')
  return { row, column }
}
export function asciiValue(text: string, name: string) {
  // Parse only the named data row, never the DDS dimensions or coordinate values.
  const line = text.split('\n').find(line => line.startsWith(name + '['))
  const value = line && Number(line.slice(line.indexOf(',') + 1).trim())
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DataError('invalid_measurement')
  return value
}
async function moisture(field: FieldLocation, token: string, signal: AbortSignal): Promise<Observation> {
  const granules = await discover('SPL4SMGP', '008', field, token, signal)
  const { row, column } = smapCell(field.longitude, field.latitude)
  for (const granule of granules) {
    const link = granule.links.find(link => !link.inherited && new URL(link.href).hostname === 'opendap.earthdata.nasa.gov')
    if (!link) continue
    const query = `/Geophysical_Data/sm_rootzone[${row}][${column}],cell_lat[${row}][${column}],cell_lon[${row}][${column}]`
    const response = await nasaFetch(safeUrl(link.href) + '.ascii?' + encodeURI(query), token, signal)
    const text = await response.text()
    const value = asciiValue(text, '/Geophysical_Data/sm_rootzone')
    if (value < 0 || value > .9) continue // -9999 is missing, not dry soil.
    if (Math.abs(asciiValue(text, 'cell_lat') - field.latitude) > .15 || Math.abs(asciiValue(text, 'cell_lon') - field.longitude) > .15) throw new DataError('grid_mismatch')
    return { value: value * 100, observedAt: granule.time_start, granuleId: granule.id, source: 'SMAP SPL4SMGP.008 sm_rootzone (0–100 cm; 9 km)', units: '%' }
  }
  throw new DataError('no_valid_pixel')
}
function bandUrl(granule: Granule, suffix: string) {
  const link = granule.links.find(link => !link.inherited && link.href.endsWith(suffix) && link.href.startsWith('https://data.lpdaac.earthdatacloud.nasa.gov/'))
  if (!link) throw new DataError('band_unavailable')
  return safeUrl(link.href)
}
async function pixel(granule: Granule, suffix: string, field: FieldLocation, token: string, signal: AbortSignal) {
  // COG byte ranges avoid downloading a full satellite tile. Do not enable workers
  // or full-file fallback: neither belongs in the edge request runtime.
  const url = bandUrl(granule, suffix)
  const client = { url, async request(options?: RequestInit) {
    const response = await nasaRequest(url, token, signal, options?.headers)
    if (!response.ok) {
      await response.body?.cancel()
      throw new DataError(response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'earthdata_access_denied' : 'nasa_unavailable')
    }
    // Enforce partial reads, even if the provider ignores our Range header.
    if (response.status !== 206) { await response.body?.cancel(); throw new DataError('range_requests_unavailable') }
    return { ok: response.ok, status: response.status, getHeader: (name: string) => response.headers.get(name) ?? undefined, getData: () => response.arrayBuffer() }
  } }
  const options = { allowFullFile: false, blockSize: 16384, cacheSize: 10 }
  const tiff = await fromCustomClient(client, options, signal)
  try {
    const image = await tiff.getImage()
    const keys = image.getGeoKeys()
    let epsg = Number(keys?.ProjectedCSTypeGeoKey)
    // ECOSTRESS C2 writes a user-defined CRS (32767) with the standard
    // GeoTIFF UTM ProjectionGeoKey instead of an EPSG ProjectedCSTypeGeoKey.
    const projection = Number(keys?.ProjectionGeoKey)
    if (epsg === 32767 && Number(keys?.GeogSemiMajorAxisGeoKey) === 6378137 && Math.abs(Number(keys?.GeogInvFlatteningGeoKey) - 298.257223563) < .000001) {
      if (projection >= 16001 && projection <= 16060) epsg = 32600 + projection - 16000
      else if (projection >= 16101 && projection <= 16160) epsg = 32700 + projection - 16100
    }
    let point: number[]
    if (epsg >= 32601 && epsg <= 32660) point = proj4('EPSG:4326', `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m`, [field.longitude, field.latitude])
    else if (epsg >= 32701 && epsg <= 32760) point = proj4('EPSG:4326', `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m`, [field.longitude, field.latitude])
    else if (Number(keys?.GeographicTypeGeoKey) === 4326 && !epsg) point = [field.longitude, field.latitude]
    else throw new DataError('unsupported_projection')
    const origin = image.getOrigin(), resolution = image.getResolution()
    const x = Math.floor((point[0] - origin[0]) / resolution[0]), y = Math.floor((point[1] - origin[1]) / resolution[1])
    if (x < 0 || y < 0 || x >= image.getWidth() || y >= image.getHeight()) throw new DataError('outside_tile')
    const data = await image.readRasters({ window: [x, y, x + 1, y + 1], samples: [0], interleave: true, signal })
    const value = Number(data[0]), noData = image.getGDALNoData()
    if (!Number.isFinite(value) || value === noData) throw new DataError('no_valid_pixel')
    return value
  } finally { await tiff.close() }
}
async function stress(field: FieldLocation, token: string, signal: AbortSignal): Promise<Observation> {
  const granules = await discover('ECO_L4T_ESI', '002', field, token, signal)
  for (const granule of granules) {
    try {
      const cloud = await pixel(granule, '_cloud.tif', field, token, signal)
      const water = await pixel(granule, '_water.tif', field, token, signal)
      if (cloud !== 0 || water !== 0) continue
      // Collection 2 ESI is a Float32 ET/PET ratio, with no scale factor.
      const value = await pixel(granule, '_ESI.tif', field, token, signal)
      if (value < 0 || value > 1) continue
      return { value, observedAt: granule.time_start, granuleId: granule.id, source: 'ECOSTRESS ECO_L4T_ESI.002 (70 m)', units: 'ESI' }
    } catch (error) {
      if (!(error instanceof DataError) || error.code !== 'no_valid_pixel') throw error
    }
  }
  throw new DataError('no_clear_land_pixel')
}
async function vegetation(field: FieldLocation, token: string, signal: AbortSignal): Promise<Observation> {
  const granules = await discover('HLSL30', '2.0', field, token, signal)
  for (const granule of granules) {
    try {
      const mask = await pixel(granule, '.Fmask.tif', field, token, signal)
      // Exclude cirrus, cloud, adjacent cloud, shadow, snow and water; bits 6–7 are aerosol.
      if (!Number.isInteger(mask) || (mask & 63) !== 0 || (mask >> 6) === 3) continue
      const red = await pixel(granule, '.B04.tif', field, token, signal)
      const nir = await pixel(granule, '.B05.tif', field, token, signal)
      if (red < 0 || nir < 0 || red > 10000 || nir > 10000 || red + nir === 0) continue
      // Both reflectance bands use scale 0.0001; it cancels in NDVI.
      return { value: (nir - red) / (nir + red), observedAt: granule.time_start, granuleId: granule.id, source: 'HLSL30.020 NDVI (30 m; not soil organic carbon)', units: 'NDVI' }
    } catch (error) {
      if (!(error instanceof DataError) || error.code !== 'no_valid_pixel') throw error
    }
  }
  throw new DataError('no_clear_land_pixel')
}
function reason(error: unknown) {
  // Never serialize upstream errors: they can contain authenticated URLs.
  return error instanceof DataError ? error.code : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'nasa_timeout' : 'nasa_unavailable'
}
export async function getFieldTelemetry(field: FieldLocation, token?: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 22000)
  async function metric(read: typeof moisture, sample: string, source: string, digits: number): Promise<MetricResult> {
    if (!token) return { status: 'sample', value: sample, source, reason: 'token_not_configured' }
    try {
      const observation = await read(field, token, controller.signal)
      return { status: 'live', ...observation, value: observation.value.toFixed(digits) }
    } catch (error) { return { status: 'sample', value: sample, source, reason: reason(error) } }
  }
  try {
    const [moistureResult, stressResult, hls] = await Promise.all([
      metric(moisture, field.moisture, 'SMAP', 1),
      metric(stress, field.stress, 'ECOSTRESS', 2),
      metric(vegetation, '', 'HLS NDVI', 3),
    ])
    return {
      blockId: field.id, location: { name: 'Ludhiana, Punjab', latitude: field.latitude, longitude: field.longitude }, fetchedAt: new Date().toISOString(),
      metrics: { moisture: moistureResult, carbon: { status: 'sample', value: field.carbon, source: 'HLS baseline', reason: 'hls_does_not_measure_soil_organic_carbon' } as MetricResult, stress: stressResult },
      vegetation: hls.status === 'live' ? hls : { ...hls, value: null },
    }
  } finally { clearTimeout(timer) }
}
