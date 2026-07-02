// nuvizz-pro-lookup.mts
//
// On-demand single-PRO lookup for the mobile "search past PROs" button. The
// client searches its saved 20-stop history locally first; only when a typed
// PRO isn't found there (and the dispatcher explicitly clicked the lookup) does
// it call this — so it's a deliberate, one-off NuVizz call, not background
// traffic. Business-name searches never reach here (handled fully client-side).
import { lookupStopByPro } from './lib/nuvizz-scan.mts';
import { setCallTrigger } from './lib/nuvizz-request.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  setCallTrigger('on-demand'); // dispatcher-initiated PRO lookup → attribute as on-demand
  const pro = new URL(req.url).searchParams.get('pro') || '';
  if (!pro.trim()) return new Response(JSON.stringify({ ok: false, reason: 'missing pro' }), { status: 400, headers: cors });
  try {
    const res = await lookupStopByPro(pro);
    return new Response(JSON.stringify(res), { status: res.ok ? 200 : 404, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'lookup failed' }), { status: 500, headers: cors });
  }
};
