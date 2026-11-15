// Cache only application assets, never Earthdata API responses or Google Maps content.
const CACHE = 'terra-shell-v4-earthdata'
const ASSETS = ['/', '/static/app.js', '/static/app.css', '/manifest.webmanifest', '/icon.svg']
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch('/static/offline-assets.json', {cache: 'no-store'})
    if (!response.ok) throw new Error('Offline asset manifest unavailable')
    const assets = await response.json()
    const cache = await caches.open(CACHE)
    await cache.addAll([...new Set([...ASSETS, ...assets])])
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith('terra-shell-') && key !== CACHE).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/api/')) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async response => {
      if (response.ok) (await caches.open(CACHE)).put('/', response.clone())
      return response
    }).catch(() => caches.match('/').then(cached => cached || Response.error())))
    return
  }
  // Same-origin JS, CSS and bundled regional fonts are cache-first for offline use.
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(async response => {
    if (response.ok) (await caches.open(CACHE)).put(event.request, response.clone())
    return response
  })))
})
