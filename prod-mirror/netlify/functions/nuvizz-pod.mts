// nuvizz-pod.mts
//
// On-demand proof-of-delivery (POD) photo proxy. Per the NuVizz Photo-Pull guide, the image
// bytes come from the deliverIt *documentapi* (NOT the v7 OpenAPI):
//
//   GET {BASE}/doc/getdocument/{companyCode}?documentGuid=<g>&objectType=02&extension=<ext>
//   BASE = https://portal.nuvizz.com/deliverit/openapi/documentapi   (Basic auth)
//   → { documentData: "<base64 image bytes>" }
//
// The base is HARDCODED (env override NUVIZZ_DOC_BASE) — it does NOT derive from NUVIZZ_BASE,
// since documentapi lives on a fixed path. We try company order [docCc, ULINE, DAVIS] (Uline
// docs sometimes resolve under DAVIS; 404 = wrong company → next) across both hosts
// (portal → contact-support), mirroring the proven scorecard implementation. Pulled with the
// server-side Basic creds through the metered requester; decoded and streamed back so an
// <img src> renders the photo without ever exposing credentials.
//
//   GET ?documentPath=<podDoc.documentPath>                  → image bytes
//   GET ?documentGuid=<g>&extension=<ext>&cc=<companyCode>   → image bytes (explicit)
//   add &format=datauri                                      → { dataUri } JSON
//   add &debug=1                                             → { attempts } JSON (diagnostic)
import { getNuvizzRequester, setCallTrigger } from './lib/nuvizz-request.mts';
import { basicAuthHeader } from './lib/nuvizz-scan.mts';

const DOC_BASE = process.env.NUVIZZ_DOC_BASE || 'https://portal.nuvizz.com/deliverit/openapi/documentapi';
// The documentapi may need an account with access to the document's org (e.g. Uline). If a
// dedicated doc account is configured, use it; otherwise fall back to the scanner's creds.
function docAuthHeader(): string {
  const u = process.env.NUVIZZ_DOC_USER, p = process.env.NUVIZZ_DOC_PASS;
  if (u && p) return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  return basicAuthHeader();
}
// Optional explicit company override for the document request; default order is
// [docCc, ULINE, DAVIS].
const DOC_COMPANY = process.env.NUVIZZ_DOC_COMPANY || '';
const FAILOVER = (u: string) => u.replace('portal.nuvizz.com', 'contact-support.nuvizz.com');
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=300' };
  const jsonHdr = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  setCallTrigger('on-demand'); // POD photo opened by a dispatcher → on-demand
  const url = new URL(req.url);

  let guid = url.searchParams.get('documentGuid') || '';
  let ext = (url.searchParams.get('extension') || '').toLowerCase();
  let cc = url.searchParams.get('cc') || '';
  const documentPath = url.searchParams.get('documentPath') || '';
  if (documentPath) {
    const sp = new URLSearchParams(documentPath.startsWith('?') ? documentPath.slice(1) : documentPath);
    guid = guid || sp.get('docGuid') || sp.get('documentGuid') || '';
    ext = ext || (sp.get('ext') || sp.get('extension') || '').toLowerCase();
    cc = cc || sp.get('cc') || '';
  }
  if (!guid) return new Response(JSON.stringify({ ok: false, reason: 'missing documentGuid' }), { status: 400, headers: jsonHdr });
  ext = ext || 'jpg';

  const headers = { Authorization: docAuthHeader(), Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const companies = [...new Set([DOC_COMPANY, cc, 'ULINE', 'DAVIS'].filter(Boolean).map((s) => s.toUpperCase()))];
  const debug = !!url.searchParams.get('debug');
  const attempts: any[] = [];

  for (const base of [DOC_BASE, FAILOVER(DOC_BASE)]) {
    for (const company of companies) {
      const target = `${base}/doc/getdocument/${encodeURIComponent(company)}?documentGuid=${encodeURIComponent(guid)}&objectType=02&extension=${encodeURIComponent(ext)}`;
      try {
        const r = await reqr.request(target, { method: 'GET', headers }, { route: '/documentapi/getdocument', tenant: company });
        if (!r.ok) { attempts.push({ company, host: base, status: r.status, body: debug ? (await r.text()).slice(0, 200) : undefined }); continue; }
        const j: any = await r.json();
        const b64 = j?.documentData || j?.documentdata;
        if (!b64 || typeof b64 !== 'string') { attempts.push({ company, host: base, status: r.status, note: 'no documentData', keys: debug ? Object.keys(j || {}) : undefined }); continue; }
        if (debug) return new Response(JSON.stringify({ ok: true, company, host: base, bytes: b64.length, attempts }), { status: 200, headers: jsonHdr });
        const mime = MIME[ext] || 'application/octet-stream';
        if (url.searchParams.get('format') === 'datauri') {
          return new Response(JSON.stringify({ ok: true, dataUri: `data:${mime};base64,${b64}` }), { status: 200, headers: jsonHdr });
        }
        return new Response(Buffer.from(b64, 'base64'), { status: 200, headers: { ...cors, 'Content-Type': mime } });
      } catch (e: any) { attempts.push({ company, host: base, error: e?.message || 'request failed' }); }
    }
  }
  return new Response(JSON.stringify({ ok: false, reason: 'document not retrievable', attempts: debug ? attempts : undefined }), { status: debug ? 200 : 502, headers: jsonHdr });
};
