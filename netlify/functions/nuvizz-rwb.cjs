'use strict'

// Route Workbench (RWB) portal-session client — the GATED path the NuVizz portal
// uses to reorder a route in ONE call (dirouteworkbench/stop/addStopsToRouteAfterValidation).
// Unlike the openapi/v7 surface (Basic auth), the RWB endpoints ride a logged-in
// PORTAL SESSION: per-host cookies + a per-host CSRF token. This function logs in
// like the browser does, holds the cookie jar, and (eventually) drives the reorder.
//
// Login flow (reverse-engineered from a portal HAR):
//   1. bootstrap CSRF on login.nuvizz.com (XSRF-TOKEN cookie == X-CSRF-TOKEN header)
//   2. POST login.nuvizz.com/loginreg/reg/checkCompanyLogin   {companyCode, appCode:"portal"}
//   3. POST login.nuvizz.com/loginreg/auth/userLogin          multipart {companyCode, username, password, appCode}
//        -> yields a JWT
//   4. POST {portal}/deliverit/instance/ndv2/openapi/loginreg/authtoken/{COMPANY}  {username:"jwt", password:<JWT>}
//        -> establishes the portal session (cookies + CSRF)
//   5. RWB calls on {portal} with the portal cookies + CSRF
//
// THIS BUILD = the `probe` action only: run the login and REPORT what it captures
// (status per step, Set-Cookie names, where the JWT/CSRF land, and whether an authed
// RWB GET succeeds). No route mutations yet — we wire those once the session is proven.
//
// Gated by NUVIZZ_WRITE_ENABLED. Credentials: portal login uses NUVIZZ_PORTAL_USER /
// NUVIZZ_PORTAL_PASS if set, else falls back to NUVIZZ_DAVIS_USER / NUVIZZ_DAVIS_PASS.

// Login gateway differs by environment: PROD = login.nuvizz.com, UAT/QA = loginqa.nuvizz.com
// (uat.nuvizz.com/deliverit redirects to loginqa.nuvizz.com/loginreg). Overridable per request.
const DEFAULT_LOGIN_BASE = 'https://login.nuvizz.com'

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) }
}

// Minimal per-host cookie jar.
function makeJar() {
  const byHost = new Map() // host -> Map(name->value)
  return {
    store(host, res) {
      let list = []
      try { list = res.headers.getSetCookie() || [] } catch { /* older node */ }
      if (!list.length) {
        const raw = res.headers.get('set-cookie')
        if (raw) list = [raw]
      }
      if (!byHost.has(host)) byHost.set(host, new Map())
      const m = byHost.get(host)
      for (const c of list) {
        const first = c.split(';')[0]
        const i = first.indexOf('=')
        if (i > 0) m.set(first.slice(0, i).trim(), first.slice(i + 1).trim())
      }
      return list.map((c) => c.split(';')[0].split('=')[0])
    },
    header(host) {
      const m = byHost.get(host)
      if (!m || !m.size) return ''
      return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    get(host, name) {
      const m = byHost.get(host)
      return m ? m.get(name) : undefined
    },
    names(host) {
      const m = byHost.get(host)
      return m ? [...m.keys()] : []
    },
  }
}

const hostOf = (u) => new URL(u).host

// fetch that feeds/eats the jar; never throws on non-2xx.
async function go(jar, method, url, { headers = {}, body } = {}) {
  const host = hostOf(url)
  const cookie = jar.header(host)
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    body,
  })
  const setNames = jar.store(host, res)
  const text = await res.text().catch(() => '')
  let data
  try { data = JSON.parse(text) } catch { data = null }
  const hdrs = {}
  for (const [k, v] of res.headers.entries()) hdrs[k] = v
  return { status: res.status, text, data, setCookies: setNames, location: res.headers.get('location'), headers: hdrs }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' })
  if (process.env.NUVIZZ_WRITE_ENABLED !== 'true') return json(403, { error: 'disabled' })

  let req = {}
  try { req = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'bad json' }) }
  const op = req.op || 'probe'

  const companyCode = req.companyCode || 'davis'          // login companyCode (lowercase in HAR)
  const COMPANY = (req.company || companyCode).toUpperCase() // path segment for authtoken
  const portalBase = req.portalBase || 'https://portal.nuvizz.com'
  const LOGIN_BASE = req.loginBase || DEFAULT_LOGIN_BASE
  const username = req.username || process.env.NUVIZZ_PORTAL_USER || process.env.NUVIZZ_DAVIS_USER
  const password = req.password || process.env.NUVIZZ_PORTAL_PASS || process.env.NUVIZZ_DAVIS_PASS
  if (!username || !password) return json(500, { error: 'no portal creds (NUVIZZ_PORTAL_USER/PASS or NUVIZZ_DAVIS_USER/PASS)' })

  if (op !== 'probe') return json(400, { error: `unknown op "${op}" (only "probe" in this build)` })

  const jar = makeJar()
  const steps = []
  const ORIGIN = LOGIN_BASE
  try {
    // 1) CSRF bootstrap — GET the login page; Spring embeds the token as a
    //    <meta name="_csrf" content="..."> tag (session-bound via the SESSION cookie),
    //    with <meta name="_csrf_header"> naming the header to echo it in.
    let csrf = null
    let csrfHeaderName = 'X-CSRF-TOKEN'
    const boot = await go(jar, 'GET', `${LOGIN_BASE}/loginreg/`)
    const mTok = (boot.text || '').match(/name=["']_csrf["']\s+content=["']([^"']+)["']/i)
    const mHdr = (boot.text || '').match(/name=["']_csrf_header["']\s+content=["']([^"']+)["']/i)
    if (mTok) csrf = mTok[1]
    if (mHdr) csrfHeaderName = mHdr[1]
    steps.push({ step: 'bootstrap GET /loginreg/', status: boot.status, setCookies: boot.setCookies, csrfFound: !!csrf, csrfHeaderName })

    const csrfHdr = csrf ? { [csrfHeaderName]: csrf } : {}

    // 2) checkCompanyLogin
    const cc = await go(jar, 'POST', `${LOGIN_BASE}/loginreg/reg/checkCompanyLogin`, {
      headers: { 'content-type': 'application/json', origin: ORIGIN, referer: `${LOGIN_BASE}/loginreg/`, ...csrfHdr },
      body: JSON.stringify({ companyCode, appCode: 'portal' }),
    })
    steps.push({ step: 'checkCompanyLogin', status: cc.status, setCookies: cc.setCookies, bodySnip: (cc.text || '').slice(0, 120) })

    // 3) userLogin (multipart) -> JWT
    const fd = new FormData()
    fd.set('companyCode', companyCode)
    fd.set('username', username)
    fd.set('password', password)
    fd.set('appCode', 'portal')
    const ul = await go(jar, 'POST', `${LOGIN_BASE}/loginreg/auth/userLogin`, {
      headers: { origin: ORIGIN, referer: `${LOGIN_BASE}/loginreg/`, ...csrfHdr },
      body: fd,
    })
    // where's the JWT? body (string/json), or a response header, or a cookie
    const jwtFromBody = typeof ul.text === 'string' && ul.text.length > 20 && ul.text.split('.').length === 3 ? ul.text : null
    // userLogin returns { status, message, data: { companyCode, username, jwtToken } }
    const jwtField = ul.data && ((ul.data.data && ul.data.data.jwtToken) || ul.data.jwtToken || ul.data.jwt || ul.data.token || ul.data.accessToken)
    // JWT might come back in a response header too (authorization / x-*-token)
    const jwtHeader = ul.headers && (ul.headers.authorization || ul.headers['x-auth-token'] || ul.headers['x-jwt-token'] || ul.headers.jwt)
    steps.push({
      step: 'userLogin', status: ul.status, setCookies: ul.setCookies,
      bodyType: ul.data ? 'json' : 'text', bodyKeys: ul.data ? Object.keys(ul.data) : undefined,
      bodySnip: (ul.text || '').slice(0, 200), jwtLooksLikeBody: !!jwtFromBody, jwtField: jwtField ? '<found>' : undefined,
      respHeaderNames: ul.headers ? Object.keys(ul.headers) : undefined, jwtHeader: jwtHeader ? '<found>' : undefined,
    })
    const jwt = jwtFromBody || jwtField || jwtHeader || jar.get(hostOf(LOGIN_BASE), 'jwt')

    // 4) authtoken on the portal host -> portal session
    let portalAuthed = false
    if (jwt) {
      const at = await go(jar, 'POST', `${portalBase}/deliverit/instance/ndv2/openapi/loginreg/authtoken/${COMPANY}`, {
        headers: { 'content-type': 'application/json', origin: portalBase, referer: `${portalBase}/deliverit/dirouteworkbench/index.html` },
        body: JSON.stringify({ username: 'jwt', password: jwt }),
      })
      steps.push({ step: 'authtoken', status: at.status, setCookies: at.setCookies, portalCookieNames: jar.names(hostOf(portalBase)), bodySnip: (at.text || '').slice(0, 150) })

      // 5) verify with an authed RWB GET (the portal CSRF may be a cookie now)
      const pcsrf = jar.get(hostOf(portalBase), 'XSRF-TOKEN') || jar.get(hostOf(portalBase), 'CSRF-TOKEN')
      const chk = await go(jar, 'GET', `${portalBase}/deliverit/dirouteworkbench/routePlan/getFilter?listName=RWStop`, {
        headers: { referer: `${portalBase}/deliverit/dirouteworkbench/index.html`, ...(pcsrf ? { 'X-CSRF-TOKEN': pcsrf } : {}) },
      })
      portalAuthed = chk.status === 200
      steps.push({ step: 'authed RWB GET (getFilter)', status: chk.status, authed: portalAuthed, portalCsrfFound: !!pcsrf, bodySnip: (chk.text || '').slice(0, 150) })
    } else {
      steps.push({ step: 'JWT', found: false, note: 'could not locate JWT from userLogin — inspect bodySnip above' })
    }

    return json(200, { ok: portalAuthed, target: { companyCode, COMPANY, portalBase, username }, steps })
  } catch (err) {
    return json(502, { error: (err && err.message) || 'probe error', steps })
  }
}
