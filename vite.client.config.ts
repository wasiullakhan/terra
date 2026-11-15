import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [tailwindcss(), {
    name: 'offline-asset-manifest',
    generateBundle(_options, bundle) {
      // Include every emitted regional font, even scripts not used on the first visit.
      this.emitFile({type:'asset',fileName:'static/offline-assets.json',source:JSON.stringify(Object.keys(bundle).map(name=>'/'+name))})
    }
  }],
  build: {
    outDir:'dist',emptyOutDir:true,
    rollupOptions:{input:'src/client.tsx',output:{entryFileNames:'static/app.js',chunkFileNames:'static/[name]-[hash].js',assetFileNames:asset=>asset.names?.some(n=>n.endsWith('.css'))?'static/app.css':'static/[name][extname]'}}
  }
})
