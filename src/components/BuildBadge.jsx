import { APP_VERSION, BUILD_COMMIT, BUILD_ENV } from '../version.js'

// Persistent build identity, rendered on every page via the Layout top bar.
// Format: "0.1.0 · a1b2c3d · preview".
export default function BuildBadge() {
  return (
    <span className={`build-badge build-badge--${BUILD_ENV}`} title="Build identity">
      <span className="build-badge__ver">{APP_VERSION}</span>
      <span className="build-badge__sep">·</span>
      <span className="build-badge__sha">{BUILD_COMMIT}</span>
      <span className="build-badge__sep">·</span>
      <span className="build-badge__env">{BUILD_ENV}</span>
    </span>
  )
}
