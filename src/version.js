// Single source of truth for the app version + build identity rendered in the
// persistent build badge. Bump APP_VERSION on every functional change (see CLAUDE.md).

export const APP_VERSION = '0.25.0'

// `__APP_COMMIT__` / `__BUILD_CONTEXT__` are replaced at build time by Vite's
// `define` (see vite.config.js), sourced from Netlify's COMMIT_REF / CONTEXT.
// The typeof guards keep this safe if the bundle is ever evaluated without them.
export const BUILD_COMMIT =
  typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'local'

const BUILD_CONTEXT_RAW =
  typeof __BUILD_CONTEXT__ !== 'undefined' ? __BUILD_CONTEXT__ : 'dev'

// Netlify CONTEXT values: production | deploy-preview | branch-deploy | dev.
// The badge only distinguishes prod vs preview (vs dev locally).
function mapEnv(context) {
  if (context === 'production') return 'prod'
  if (context === 'deploy-preview' || context === 'branch-deploy') return 'preview'
  return 'dev'
}

export const BUILD_ENV = mapEnv(BUILD_CONTEXT_RAW)

// e.g. "0.1.0 · a1b2c3d · preview"
export const BUILD_LABEL = `${APP_VERSION} · ${BUILD_COMMIT} · ${BUILD_ENV}`
