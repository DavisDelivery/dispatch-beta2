#!/usr/bin/env node
// Finish the dd-dispatch-map-uat (prod-mirror) data bring-up AFTER the named
// Firestore database `uat-mirror` has been created (see docs/UAT-MIRROR-DATA.md).
//
//   1. Release the project's existing Firestore ruleset to the `uat-mirror`
//      database (the client SDK reads the board directly, so the named DB needs
//      its own rules release; the deployed ruleset already matches any {database}).
//   2. Trigger the mirror's manual scan.
//   3. Print the scan result per date so loads/stops landing is visible.
//
// Auth: the Firebase Admin service-account JSON, from the FIREBASE_SA env var or a
// file path passed as argv[2].
//
//   FIREBASE_SA='{"type":"service_account",...}' node scripts/uat-mirror-finish.mjs
//   node scripts/uat-mirror-finish.mjs /path/to/sa.json

import { readFileSync } from 'fs'
import crypto from 'crypto'

const PROJECT = 'davismarginiq'
const DATABASE = 'uat-mirror'
const MIRROR_SITE = 'https://dd-dispatch-map-uat.netlify.app'

const saRaw = process.env.FIREBASE_SA || (process.argv[2] ? readFileSync(process.argv[2], 'utf8') : null)
if (!saRaw) {
  console.error('No credentials: set FIREBASE_SA or pass a service-account JSON path.')
  process.exit(1)
}
const sa = JSON.parse(saRaw)

async function getToken(scope) {
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error('token exchange failed: ' + JSON.stringify(j))
  return j.access_token
}

const tok = await getToken('https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase')
const H = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }

// ── 0. the database must exist ──────────────────────────────────────────────
{
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}`, { headers: H })
  if (r.status === 404) {
    console.error(`Database "${DATABASE}" does not exist yet. Create it first (Owner/Editor account):\n` +
      `  gcloud firestore databases create --database=${DATABASE} --location=nam5 --type=firestore-native --project=${PROJECT}`)
    process.exit(1)
  }
  console.log(`database ${DATABASE}: exists (${r.status})`)
}

// ── 1. rules release for the named database ─────────────────────────────────
{
  const rel = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, { headers: H }).then((r) => r.json())
  const defaultRelease = (rel.releases || []).find((x) => x.name.endsWith('/releases/cloud.firestore'))
  if (!defaultRelease) throw new Error('no cloud.firestore release found on the project')
  const releaseName = `projects/${PROJECT}/releases/cloud.firestore/${DATABASE}`
  const already = (rel.releases || []).find((x) => x.name === releaseName)
  if (already) {
    console.log(`rules release for ${DATABASE}: already present`)
  } else {
    const r = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: releaseName, rulesetName: defaultRelease.rulesetName }),
    })
    const j = await r.json()
    if (!r.ok) throw new Error(`rules release failed: ${r.status} ${JSON.stringify(j)}`)
    console.log(`rules release for ${DATABASE}: created (ruleset ${defaultRelease.rulesetName.split('/').pop()})`)
  }
}

// ── 2. manual scan ───────────────────────────────────────────────────────────
{
  console.log('triggering manual scan…')
  const r = await fetch(`${MIRROR_SITE}/.netlify/functions/nuvizz-manual-scan`, { method: 'POST' })
  const j = await r.json().catch(() => null)
  console.log('scan:', r.status, JSON.stringify(j, null, 1))
  const bad = (j?.dates || []).filter((d) => d && d.ok === false)
  if (!j?.ok || bad.length) {
    console.error('\nScan reported errors. If they mention listdef/filterdata, redeploy the site so the')
    console.error('NUVIZZ_LISTDEF_* env vars are baked into the functions, then re-run this script.')
    process.exit(1)
  }
  const counts = (j?.dates || []).map((d) => `${d.date}: ${d.count ?? 0} stops (${d.planned ?? 0} planned / ${d.unplanned ?? 0} unplanned)`)
  console.log('\nBoard written:\n  ' + counts.join('\n  '))
  console.log(`\nOpen ${MIRROR_SITE} — the UAT loads/stops should be on the board.`)
}
