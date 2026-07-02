// nuvizz-stop-events.mts
//
// On-demand activity timeline for a single stop (the portal's "Activity Timeline":
// STOP PLANNED / PICKUP DEPART / DISPATCHED / UPDATED / UNPLANNED, with time + user +
// company). Called only when a dispatcher opens the timeline on an individual order — a
// deliberate, one-off NuVizz call, not background traffic. Prefers the richer
// /event/eventinfo (carries the "By:"/"From:") when the system stopId is known; otherwise
// falls back to /stop/eventinfo by stop number. Creds stay server-side.
import { fetchStopEvents } from './lib/nuvizz-scan.mts';
import { setCallTrigger } from './lib/nuvizz-request.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  setCallTrigger('on-demand'); // dispatcher opened the activity timeline → on-demand
  const url = new URL(req.url);
  const stopNbr = url.searchParams.get('stopNbr') || '';
  const stopId = url.searchParams.get('stopId') || '';
  if (!stopNbr.trim() && !stopId.trim()) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing stopNbr or stopId' }), { status: 400, headers: cors });
  }
  try {
    const res = await fetchStopEvents(stopNbr, stopId);
    return new Response(JSON.stringify(res), { status: res.ok ? 200 : 404, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'events failed' }), { status: 500, headers: cors });
  }
};
