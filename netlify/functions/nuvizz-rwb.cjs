'use strict'

// Route Workbench (RWB) portal-session client — the GATED 1-call reorder path the
// NuVizz portal uses (dirouteworkbench/stop/addStopsToRouteAfterValidation).
//
// AUTH (fully reverse-engineered + proven server-side):
//   1. GET  {loginBase}/loginreg/                      -> SESSION + <meta _csrf> token
//   2. POST {loginBase}/loginreg/reg/checkCompanyLogin {companyCode, appCode:"portal"}  + X-CSRF-TOKEN
//   3. POST {loginBase}/loginreg/auth/userLogin        multipart {companyCode,username,password,appCode} -> JWT (data.data.jwtToken)
//   4. POST {portalBase}/deliverit/instance/ndv2/openapi/loginreg/authtoken/{COMPANY} {username:"jwt",password:JWT} -> authToken
//   5. RWB calls: Authorization: Basic base64("JWT:"+authToken)  + Cookie: Instance=ndv2
//   loginBase: PROD=login.nuvizz.com, UAT/QA=loginqa.nuvizz.com
//
// Ops:
//   probe   -> run the login and verify with a read-only getFilter (reports steps)
//   rwb     -> generic authed request to the portal: { method, path, query?, form?, json? }
//              (path is under {portalBase}/deliverit). Returns { status, body }.
//   reorder -> POST dirouteworkbench/stop/addStopsToRouteAfterValidation
//              { routePlanId, stopIds:[...ordered], isPlanningMode?, csrf? }
//
// Gated by NUVIZZ_WRITE_ENABLED. Creds: NUVIZZ_PORTAL_USER/PASS else NUVIZZ_DAVIS_USER/PASS.
// (No route mutation happens except via the explicit `reorder`/`rwb` ops.)

const DEFAULT_LOGIN_BASE = 'https://login.nuvizz.com'

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) }
}

function makeJar() {
  const byHost = new Map()
  return {
    store(host, res) {
      let list = []
      try { list = res.headers.getSetCookie() || [] } catch { /* older node */ }
      if (!list.length) { const raw = res.headers.get('set-cookie'); if (raw) list = [raw] }
      if (!byHost.has(host)) byHost.set(host, new Map())
      const m = byHost.get(host)
      for (const c of list) { const f = c.split(';')[0]; const i = f.indexOf('='); if (i > 0) m.set(f.slice(0, i).trim(), f.slice(i + 1).trim()) }
      return list.map((c) => c.split(';')[0].split('=')[0])
    },
    header(host) { const m = byHost.get(host); return m && m.size ? [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : '' },
    get(host, name) { const m = byHost.get(host); return m ? m.get(name) : undefined },
  }
}
const hostOf = (u) => new URL(u).host

async function go(jar, method, url, { headers = {}, body } = {}) {
  const host = hostOf(url)
  const cookie = jar.header(host)
  const res = await fetch(url, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers }, body })
  jar.store(host, res)
  const text = await res.text().catch(() => '')
  let data
  try { data = JSON.parse(text) } catch { data = null }
  return { status: res.status, text, data }
}

// Full login -> { authToken, jar, steps, error }
async function portalLogin(cfg) {
  const { LOGIN_BASE, portalBase, companyCode, COMPANY, username, password } = cfg
  const jar = makeJar()
  const steps = []
  const ref = `${portalBase}/deliverit/dirouteworkbench/index.html`

  const boot = await go(jar, 'GET', `${LOGIN_BASE}/loginreg/`)
  const mTok = (boot.text || '').match(/name=["']_csrf["']\s+content=["']([^"']+)["']/i)
  const mHdr = (boot.text || '').match(/name=["']_csrf_header["']\s+content=["']([^"']+)["']/i)
  const csrf = mTok ? mTok[1] : null
  const csrfHeaderName = mHdr ? mHdr[1] : 'X-CSRF-TOKEN'
  steps.push({ step: 'bootstrap', status: boot.status, csrfFound: !!csrf })
  if (!csrf) return { error: 'no CSRF token from login page', steps }
  const csrfHdr = { [csrfHeaderName]: csrf }

  const cc = await go(jar, 'POST', `${LOGIN_BASE}/loginreg/reg/checkCompanyLogin`, {
    headers: { 'content-type': 'application/json', origin: LOGIN_BASE, referer: `${LOGIN_BASE}/loginreg/`, ...csrfHdr },
    body: JSON.stringify({ companyCode, appCode: 'portal' }),
  })
  steps.push({ step: 'checkCompanyLogin', status: cc.status })

  const fd = new FormData()
  fd.set('companyCode', companyCode); fd.set('username', username); fd.set('password', password); fd.set('appCode', 'portal')
  const ul = await go(jar, 'POST', `${LOGIN_BASE}/loginreg/auth/userLogin`, {
    headers: { origin: LOGIN_BASE, referer: `${LOGIN_BASE}/loginreg/`, ...csrfHdr }, body: fd,
  })
  const jwt = ul.data && ((ul.data.data && ul.data.data.jwtToken) || ul.data.jwtToken)
  steps.push({ step: 'userLogin', status: ul.status, jwt: !!jwt, msg: ul.data && ul.data.message })
  if (!jwt) return { error: 'login failed (no JWT)', steps }

  const at = await go(jar, 'POST', `${portalBase}/deliverit/instance/ndv2/openapi/loginreg/authtoken/${COMPANY}`, {
    headers: { 'content-type': 'application/json', origin: portalBase, referer: ref },
    body: JSON.stringify({ username: 'jwt', password: jwt }),
  })
  const authToken = at.data && (at.data.authToken || at.data.token || at.data.jwtToken)
  steps.push({ step: 'authtoken', status: at.status, authToken: !!authToken })
  if (!authToken) return { error: 'no authToken', steps }

  return { authToken, jar, steps, ref }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' })
  if (process.env.NUVIZZ_WRITE_ENABLED !== 'true') return json(403, { error: 'disabled' })
  let req = {}
  try { req = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'bad json' }) }
  const op = req.op || 'probe'

  const companyCode = req.companyCode || 'davis'
  const COMPANY = (req.company || companyCode).toUpperCase()
  const portalBase = req.portalBase || 'https://portal.nuvizz.com'
  const LOGIN_BASE = req.loginBase || DEFAULT_LOGIN_BASE
  const username = req.username || process.env.NUVIZZ_PORTAL_USER || process.env.NUVIZZ_DAVIS_USER
  const password = req.password || process.env.NUVIZZ_PORTAL_PASS || process.env.NUVIZZ_DAVIS_PASS
  if (!username || !password) return json(500, { error: 'no portal creds' })

  const cfg = { LOGIN_BASE, portalBase, companyCode, COMPANY, username, password }

  try {
    const sess = await portalLogin(cfg)
    if (sess.error) return json(200, { ok: false, ...sess })
    const basic = 'Basic ' + Buffer.from(`JWT:${sess.authToken}`).toString('base64')
    const rwbHeaders = { authorization: basic, cookie: 'Instance=ndv2', referer: sess.ref }

    if (op === 'probe') {
      const chk = await go(sess.jar, 'GET', `${portalBase}/deliverit/dirouteworkbench/routePlan/getFilter?listName=RWStop`, { headers: rwbHeaders })
      return json(200, { ok: chk.status === 200, steps: sess.steps, getFilter: chk.status })
    }

    if (op === 'rwb') {
      // generic authed request: { method, path, query?, form?, json? }
      const method = (req.method || 'GET').toUpperCase()
      let url = `${portalBase}/deliverit/${String(req.path || '').replace(/^\//, '')}`
      if (req.query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(req.query).toString()
      let body, extra = {}
      if (req.form) {
        const f = new FormData()
        for (const [k, v] of Object.entries(req.form)) f.set(k, String(v))
        body = f
      } else if (req.json) { body = JSON.stringify(req.json); extra = { 'content-type': 'application/json' } }
      const r = await go(sess.jar, method, url, { headers: { ...rwbHeaders, origin: portalBase, ...extra }, body })
      return json(200, { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.data ?? r.text.slice(0, 4000) })
    }

    if (op === 'reorder') {
      const { routePlanId, stopIds } = req
      if (!routePlanId || !Array.isArray(stopIds) || !stopIds.length) return json(400, { error: 'reorder needs routePlanId and stopIds[]' })
      const f = new FormData()
      f.set('routePlanId', routePlanId)
      f.set('stopIds', stopIds.join(','))
      f.set('isPlanningMode', req.isPlanningMode == null ? 'true' : String(req.isPlanningMode))
      if (req.csrf) f.set('_csrf', req.csrf)
      const r = await go(sess.jar, 'POST', `${portalBase}/deliverit/dirouteworkbench/stop/addStopsToRouteAfterValidation`, {
        headers: { ...rwbHeaders, origin: portalBase }, body: f,
      })
      return json(200, { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.data ?? r.text.slice(0, 2000) })
    }

    return json(400, { error: `unknown op "${op}"` })
  } catch (err) {
    return json(502, { error: (err && err.message) || 'error' })
  }
}
