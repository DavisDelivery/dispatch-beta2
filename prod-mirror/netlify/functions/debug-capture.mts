// debug-capture.mts
//
// Receives a "Debug this view" capture bundle from the dispatch-map ChatPanel
// and files it as a GitHub issue, so a coding agent can pick up the investigation
// and open a PR. Async ("lean") backend for the in-app coding agent — no live
// chat yet (a Netlify function can't host a repo + git). Nothing here ever pushes
// to main or deploys; the agent opens a PR the dispatcher reviews.
//
// Required env:
//   DEBUG_CAPTURE_GH_TOKEN   PAT with `repo` (or fine-grained Issues:write) scope.
//   NOTE: GITHUB_TOKEN is RESERVED on Netlify and can't be set; GH_TOKEN also works.
// Optional env:
//   DEBUG_CAPTURE_REPO     "owner/repo"            (default: DavisDelivery/davis-nuvizz)
//   DEBUG_CAPTURE_LABELS   "a,b" labels to apply   (default: none — avoids 422 on missing label)
//   DEBUG_CAPTURE_MENTION  text prepended to body  (e.g. "@claude" to trigger a GitHub agent)
//   DEBUG_CAPTURE_SECRET   if set, requires header x-debug-secret to match. The app is
//                          unauthenticated, so this is a speed bump vs drive-by issue
//                          spam, not real auth (VITE_DEBUG_CAPTURE_SECRET ships in the bundle).
//
// Request:  POST application/json — body is the dispatch-map.debug-capture/v1 bundle.
// Response: { ok: true, issueUrl, issueNumber } | { ok: false, error }

const DEFAULT_REPO = 'DavisDelivery/davis-nuvizz';
const MAX_BODY_CHARS = 60000; // GitHub issue body hard cap is 65536.
const FN_BUILD = 'debug-capture v1'; // touch to force a full (non-empty) rebuild

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-debug-secret',
  'Content-Type': 'application/json',
};

function getToken(): string | undefined {
  // GITHUB_TOKEN is a RESERVED name on Netlify (its GitHub integration owns it)
  // and can't be set as a project env var, so the primary name is custom.
  return process.env.DEBUG_CAPTURE_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
}

// Truncate so the RETURNED string — including the truncation notice — is <= max.
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const notice = `\n…[truncated ${s.length} chars]`;
  return s.slice(0, Math.max(0, max - notice.length)) + notice;
}

function firstLine(s: unknown, max = 80): string {
  const line = String(s || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function buildIssueBody(bundle: any): string {
  const app = bundle?.app || {};
  const scope = bundle?.scope || {};
  const src = bundle?.source || {};
  const sel = bundle?.selection || {};
  const ai = bundle?.ai || {};
  const lines: string[] = [];

  const mention = process.env.DEBUG_CAPTURE_MENTION;
  if (mention) lines.push(mention, '');

  lines.push('**Reported from dispatch-map "Debug this view".**', '');
  if (bundle?.user_note) lines.push('> ' + String(bundle.user_note).replace(/\n/g, '\n> '), '');

  lines.push('| field | value |', '| --- | --- |');
  lines.push(`| captured_at | ${bundle?.captured_at || '—'} |`);
  lines.push(`| app | v${app.version || '?'} (${app.build_commit || '?'})${app.is_mobile ? ' · mobile' : ' · desktop'} |`);
  lines.push(`| date | ${scope.date || '—'}${scope.date_is_today ? ' (today)' : ''}${scope.mock_mode ? ' · MOCK' : ''} |`);
  lines.push(`| stops | ${src.stops_count_visible ?? '?'} visible / ${src.stops_count_total ?? '?'} total · src ${src.stops_source || '—'} |`);
  lines.push(`| freshness | refreshed ${src.last_refreshed || '—'} · scanned ${src.last_scanned_at || '—'} |`);
  const selDesc = sel.kind === 'stop' && sel.stop
    ? `stop ${sel.stop.stopNbr ?? ''} (pro ${sel.stop.pro ?? ''}, load ${sel.stop.loadNbr ?? '—'})`
    : sel.kind === 'driver' && sel.driver
    ? `driver ${sel.driver.driverName ?? sel.driver.driverUserName ?? ''}`
    : sel.kind === 'route'
    ? `route/load ${sel.route_load_nbr ?? ''}`
    : sel.kind === 'multi'
    ? `${sel.multi_count} stops (${sel.select_mode || 'multi'})`
    : 'none';
  lines.push(`| selection | ${selDesc} |`);
  if (ai.active) lines.push(`| ai highlight | ${ai.summary || ''} (${ai.source || '?'}) |`);
  if (bundle?.map_viewport?.center) {
    lines.push(`| map | center ${bundle.map_viewport.center.lat},${bundle.map_viewport.center.lng} · z${bundle.map_viewport.zoom} |`);
  }
  lines.push('');
  if (bundle?.static_map_url) {
    lines.push(`[Static map of the view](${bundle.static_map_url}) — swap __MAPS_KEY__ for the Maps key to open.`, '');
  }

  let header = lines.join('\n');

  // Fence longer than any backtick run in the content so stray ``` can't break the block.
  const fenceLen = Math.max(3, ...((JSON.stringify(bundle).match(/`+/g) || []).map((m) => m.length + 1)));
  const fence = '`'.repeat(fenceLen);
  const wrap = (h: string, j: string) =>
    `${h}\n<details><summary>Full capture bundle (JSON)</summary>\n\n${fence}json\n${j}\n${fence}\n</details>\n`;
  const overhead = wrap('', '').length;

  if (header.length > MAX_BODY_CHARS - overhead - 1000) {
    header = truncate(header, MAX_BODY_CHARS - overhead - 1000);
  }
  const json = truncate(JSON.stringify(bundle, null, 2), Math.max(0, MAX_BODY_CHARS - overhead - header.length));
  const body = wrap(header, json);
  return body.length <= MAX_BODY_CHARS ? body : body.slice(0, MAX_BODY_CHARS);
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405, headers: CORS });
  }

  const requiredSecret = process.env.DEBUG_CAPTURE_SECRET;
  if (requiredSecret && req.headers.get('x-debug-secret') !== requiredSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401, headers: CORS });
  }

  const token = getToken();
  if (!token) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Server is missing DEBUG_CAPTURE_GH_TOKEN — set it in Netlify env to enable filing issues.' }),
      { status: 503, headers: CORS },
    );
  }

  let bundle: any;
  try {
    bundle = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Body must be JSON' }), { status: 400, headers: CORS });
  }
  if (!bundle || bundle.schema !== 'dispatch-map.debug-capture/v1') {
    return new Response(
      JSON.stringify({ ok: false, error: 'Expected a dispatch-map.debug-capture/v1 bundle' }),
      { status: 400, headers: CORS },
    );
  }

  const repo = process.env.DEBUG_CAPTURE_REPO || DEFAULT_REPO;
  const labels = (process.env.DEBUG_CAPTURE_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const title = `[dispatch-map debug] ${firstLine(bundle.user_note) || 'unexpected behavior'}`;
  const body = buildIssueBody(bundle);

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'dispatch-map-debug-capture',
      },
      body: JSON.stringify(labels.length ? { title, body, labels } : { title, body }),
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: `GitHub ${resp.status}: ${data?.message || 'issue create failed'}` }),
        { status: 502, headers: CORS },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, issueUrl: data.html_url, issueNumber: data.number }),
      { status: 200, headers: CORS },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'request failed' }), { status: 500, headers: CORS });
  }
};
