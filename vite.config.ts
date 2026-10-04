import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: Number(process.env.VITE_PORT ?? 5173), strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3001}` },
    // Trailer edit/render output changes constantly; a reload would kill a running frame render.
    watch: { ignored: ['**/work/trailer-edit/**', '**/work/trailer-renders/**'] } },
  // Scan only the app's own pages for dependencies: node_modules.cloud-backup-* holds
  // thousands of stalled iCloud placeholder HTML files that break the scan.
  optimizeDeps: { entries: ['index.html', 'tests/*.html'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2400, rollupOptions: {
    onwarn(warning,warn) { if(warning.code==='MODULE_LEVEL_DIRECTIVE'&&warning.message.includes('use client'))return;warn(warning); },
    output: { manualChunks: { three: ['three'], physics: ['@dimforge/rapier3d-compat'] } }
  } }
});
