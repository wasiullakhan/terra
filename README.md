# Terra — Field Intelligence

## Overview

React/TypeScript dashboard served by Hono on Cloudflare Pages. This update restores the supplied `terra_dashboard_search_maps_reports.tar.gz` and replaces the telemetry data path with authenticated NASA Earthdata requests. Existing card element hierarchy, CSS classes, stylesheets, typography and spacing are preserved. Only values, status text and accessibility/provenance attributes change.

## Completed features

- Server-only Earthdata bearer authentication using `NASA_EARTHDATA_TOKEN`. No token in React, API responses, browser storage, URLs, tracked files or the source archive.
- Live **SMAP SPL4SMGP.008** root-zone moisture: CMR discovery, authenticated OPeNDAP single-cell extraction of `/Geophysical_Data/sm_rootzone`, EASE-Grid 2.0 coordinate mapping with returned-coordinate verification, `m3/m3 × 100` conversion. This is modeled 0–100 cm root-zone moisture at approximately 9 km resolution, not a parcel sensor.
- Live **ECOSTRESS ECO_L4T_ESI.002**: authenticated COG range reads at the field coordinate, WGS84/UTM projection support including Collection 2 user-defined CRS metadata, cloud/water masking, valid-pixel checks and native Float32 ET/PET ESI ratio (no percentage conversion).
- Live **HLSL30.020 NDVI**: authenticated red B04/NIR B05 point reads, Fmask quality filtering, reflectance checks and `(NIR − red)/(NIR + red)`. Vegetation results are exposed separately in the API.
- Per-metric failures retain the original selected field's sample. Authentication failures, rate limits, upstream errors, absent coverage, invalid pixels and timeouts do not break the dashboard. One failing dataset does not discard another dataset's success.
- Loading ellipses and loading text use existing value/status slots without new HTML wrappers or CSS. `aria-busy`/`aria-live` support assistive technology.
- Field switching cancels stale browser requests. Offline mode restores the original sample; reconnect retries NASA. No sample seeding or IndexedDB read can overwrite the live response.
- Reports use current card values and include mixed-source status and each measurement's observation date. Existing sparklines remain illustrative, not live time series, and have explanatory accessibility labels.
- All existing map search/GPS/Google Maps adapter, multilingual UI, saved plans, QR sharing, fractional planning horizon and report features remain.

## Important scientific limitation

**HLS does not measure soil organic carbon. NDVI or reflectance cannot truthfully replace a soil-carbon percentage.** The unchanged Soil organic carbon card therefore remains the original sample (`0.58%` for North field), marked `Sample baseline`; the API explicitly returns `hls_does_not_measure_soil_organic_carbon`. HLS NDVI is available under `vegetation` but is not mislabeled or converted into carbon. A validated, locally calibrated model with ground-truth soil data is required before implementing live carbon estimates.

The original agronomic tags (such as “Optimal range”) are replaced in their existing text slots by “NASA observation” or “Sample baseline”; this avoids claiming that a newly observed value has a validated agronomic interpretation. No styles or structural HTML are changed.

## URLs and entry points

- Temporary preview: https://3000-i38za2r7f3gtmqo1p1s45-8f57ffe2.sandbox.novita.ai
- Production: not deployed in this session.
- `/`: dashboard; NASA requests start automatically when online.
- `/api/field-data?field=PB-LDH-042`: North field at latitude `30.912`, longitude `75.849`, Ludhiana, Punjab. Field is optional and defaults to North field.
- Allowed additional field IDs: `PB-LDH-043` (30.913, 75.854), `PB-LDH-044` (30.908, 75.850). Unknown fields return HTTP 400; arbitrary upstream URLs and arbitrary-coordinate scraping are not accepted.
- `/api/maps/config`, `/api/maps/loader`: unchanged Google Maps configuration/loader endpoints.
- `/#state=<lz-string encoded JSON>`: existing shared scenario import.
- `/#generate-report`: report controls.
- `/sw.js`, `/static/app.js`, `/static/app.css`, `/static/offline-assets.json`, `/manifest.webmanifest`, `/icon.svg`: existing app assets.

### Telemetry response

`blockId`, `location`, `fetchedAt`, and `metrics.{moisture,carbon,stress}`. Each metric contains `value` (formatted string), `status` (`live` or `sample`), and `source`. Successful observations include `observedAt`, `granuleId` and units; sample fallback includes a machine-readable `reason`. `vegetation` is a separately typed NDVI result (null value on failure).

NASA discovery examines the two most recent matching granules within a rolling 90-day window, newest first. HLS and ECOSTRESS can skip invalid/cloudy candidates. It does not search an unlimited archive. Observation dates may differ substantially between datasets; “live” means fetched from NASA, not measured today. The complete request has a 22-second upstream deadline; the browser gives it 25 seconds. Successful mixed responses have a private five-minute browser cache; complete fallback responses are `no-store`. There are no automatic immediate retries on HTTP 429.

## Credentials and security

For local development, set `NASA_EARTHDATA_TOKEN` in the git-ignored `.dev.vars` file. The supplied credential is configured only in this sandbox's ignored local secret file and is deliberately excluded from downloadable source. Do not commit it. In production, set the same variable as an encrypted Cloudflare secret through the selected deployment system before testing the deployed API. Without it, all cards gracefully use their original samples.

All NASA CMR, OPeNDAP and data-host requests carry the server-side bearer. Redirects are followed manually: credentials are only attached to the explicit NASA host allowlist, never to CloudFront or S3 distribution URLs. Those use NASA's signed download authorization. Unknown redirect destinations are rejected. Upstream exception messages and signed URLs are not returned. GeoTIFF reads require partial-content responses, never full-file downloads or a browser/Node worker pool.

Rotate the Earthdata credential after sharing it in chat, monitor its expiration and NASA quotas, and configure public-endpoint rate limiting before production use. No production rate-limiting infrastructure was provisioned in this session. Existing `GOOGLE_MAPS_BROWSER_KEY` is optional and separate: this intentionally public Google browser key must be restricted by referrer and enabled APIs; no Google key was supplied, so the existing basic iframe remains the map fallback.

## Data architecture and storage

- NASA observations are fetched per request and held only for that request/page lifecycle. No new persistent backend data store is needed or configured; there is no in-memory server cache or runtime filesystem access.
- Browser Dexie/IndexedDB `terra-field-intelligence` remains schema v2: `settings`, `scenarios`, `outbox`, and legacy `fieldBundles`. The legacy field bundle store is retained for migration compatibility but no longer drives telemetry or receives a sample overwrite on startup.
- `localStorage.terra-language` and the existing on-device plans remain unchanged.
- Service worker cache `terra-shell-v4-earthdata` replaces older shell caches. It precaches app/fonts and bypasses every `/api/*` request; it never stores Earthdata credentials or observations. Offline telemetry deliberately uses the original bundled samples rather than silently presenting stale readings as live.
- Map search/GPS still controls the existing map only; telemetry is bound to the selected named Ludhiana field, not arbitrary map navigation. Field boundaries are demonstration geometry, not surveyed ownership data.

## User guide

1. Open the dashboard online and wait for loading to finish. Moisture and stress use NASA values when available; per-card text/title identifies sample fallback or observation provenance.
2. Hover a telemetry card to see its NASA observation date/source or fallback reason. Inspect `/api/field-data` for all observation metadata and independent HLS NDVI.
3. Change the selected field to load its own coordinates and baseline. Moving the map or searching another address does not claim to change the measurement field.
4. Continue planning, saving/sharing scenarios and generating reports as before. Reports are self-contained HTML suitable for browser Print → Save as PDF.
5. Offline, plans continue working and telemetry clearly returns to samples. Coming back online triggers a new fetch.

## Development and tests

```sh
npm ci
npm run build
pm2 start ecosystem.config.cjs
npx tsc --noEmit
node --import tsx --test test-earthdata.mjs
node test-earthdata-ui.mjs
node test-ui.mjs
```

Preview listens on `0.0.0.0:3000`. Install Chromium and its system libraries with Playwright if necessary. After rebuilding the Worker, stop the PM2 app, free port 3000, and start `ecosystem.config.cjs` again so Wrangler definitely loads the new bundle.

Validation completed:

- TypeScript and Vite frontend/Worker builds pass.
- 14 backend tests pass: CMR auth/coordinates, SMAP point parsing/conversion, raster ESI/NDVI reads, independent carbon sample, missing credential, 401/403/429/500, timeout, fill values, cloud/water/Fmask rejection, malformed responses, redirect credential isolation, URL/field validation and cache headers.
- NASA browser integration tests pass: loading, live and partial success, malformed/rate-limit fallback, original card hierarchy, 320/390/768/1440px widths, stale-request cancellation, offline/reconnect and report provenance; no page JavaScript errors.
- Existing complete UI suite passes with deterministic NASA fallback: four languages, offline fonts/reload/planning, persistence, maps/search/GPS errors and retries, drawer navigation, saved/QR/fractional scenarios and report preview/download. Google keyed adapter is contract-mocked, not live-key tested.
- Real authenticated requests through Wrangler returned SMAP `17.7%` (2026-11-10), ECOSTRESS `0.94 ESI` (2026-10-19), and HLS NDVI `0.079` (2026-10-22) for North field. These are test-time observations, not future expected constants.
- Stylesheets are identical to the uploaded baseline. Earthdata token is absent from tracked source, built browser assets and API responses.

## Remaining limitations and recommended next steps

- Soil carbon remains sample-only until an agronomically validated carbon model and ground truth are supplied. Do not interpret NDVI as carbon.
- Verify NASA product/version lifecycle and regional QA with a domain expert. The current short-name/version choices are verified against live NASA services, but future collection migrations may require maintenance.
- Consider D1/R2-backed observation snapshots and scheduled/offline ingestion if long-term histories, extended cloudy-period search or production-scale traffic become requirements. No cloud sync, live weather feed, calibrated forecast or full satellite histories are implemented here.
- Existing card/report sparklines, weather, rotation projections, confidence badges and field boundaries remain illustrative. Do not treat these as additional NASA measurements.
- Configure rotated production secrets and quotas/rate limiting. No Cloudflare resources are required for local development.
- Review regional translations with native speakers. Existing dependencies report three moderate npm audit advisories; no unrelated force upgrades were performed.

## Configuration

Hono + React/TypeScript + Vite + Wrangler. `src/earthdata.ts` contains the server-only NASA adapters; `src/index.ts` owns API routes; `src/client.tsx` owns card state. GeoTIFF and proj4 are backend dependencies and do not enter the browser bundle. Production setup remains in `wrangler.jsonc`; no D1/KV/R2 bindings or runtime filesystem operations were added.

## Vercel deployment

The project can also deploy to Vercel from this repository. Vercel serves checked-in files under `public/` from its CDN and runs the Hono API as a Function. Regenerate and commit the files in `public/static/` with `npm run build:vercel` whenever client code or styles change. Configure `NASA_EARTHDATA_TOKEN` as a Vercel environment variable to enable live NASA measurements; without it, the dashboard safely displays sample baselines. `GOOGLE_MAPS_BROWSER_KEY` is optional.

Last updated: 2026-11-15.
