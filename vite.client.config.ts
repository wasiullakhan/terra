import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig(({ mode }) => ({
  // Vercel serves public/ as CDN assets; Cloudflare Pages bundles them into dist/.
  build: {
    outDir:mode === 'vercel' ? 'public' : 'dist',
    emptyOutDir:mode !== 'vercel',
    rollupOptions:{input:'src/client.tsx',output:{entryFileNames:'static/app.js',chunkFileNames:'static/[name]-[hash].js',assetFileNames:asset=>asset.names?.some(n=>n.endsWith('.css'))?'static/app.css':'static/[name][extname]'}}
  },
  plugins: [tailwindcss(), {
    name: 'offline-asset-manifest',
    generateBundle(_options, bundle) {
      // Include every emitted regional font, even scripts not used on the first visit.
      this.emitFile({type:'asset',fileName:'static/offline-assets.json',source:JSON.stringify(Object.keys(bundle).map(name=>'/'+name))})
    }
  }]
}))
