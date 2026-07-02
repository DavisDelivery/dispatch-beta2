import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

const commit = (process.env.COMMIT_REF || '').slice(0, 7) || 'dev';
const builtAt = new Date().toISOString();
// Netlify deploy context (CONTEXT): production | deploy-preview | branch-deploy | dev.
// Map to a short label; absent (local dev) → 'dev'. Never undefined.
const ctxRaw = process.env.CONTEXT || '';
const context = ctxRaw === 'production' ? 'prod'
  : ctxRaw === 'deploy-preview' ? 'preview'
  : ctxRaw === 'branch-deploy' ? 'branch'
  : (ctxRaw || 'dev');

export default defineConfig({
  plugins: [
    react(),
    visualizer({
      filename: 'dist/bundle-stats.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
      open: false,
    }),
  ],
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(builtAt),
    __BUILD_CONTEXT__: JSON.stringify(context),
  },
});
