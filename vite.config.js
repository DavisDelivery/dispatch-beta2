import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build metadata is injected from Netlify build environment variables at
// build time (https://docs.netlify.com/configure-builds/environment-variables/).
// These are NON-secret build vars, so it is safe to bake them into the client
// bundle. NuVizz credentials are NEVER exposed here — they stay server-side in
// the Netlify Functions runtime only.
const commitRef = process.env.COMMIT_REF || ''
const buildCommit = commitRef ? commitRef.slice(0, 7) : 'local'
const buildContext = process.env.CONTEXT || 'dev'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(buildCommit),
    __BUILD_CONTEXT__: JSON.stringify(buildContext),
  },
})
