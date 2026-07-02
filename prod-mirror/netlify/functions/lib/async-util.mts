// lib/async-util.mts
//
// PR 5A reliability primitives. Two tiny, dependency-free helpers used to make the
// build path impossible to hang:
//
//   fetchWithTimeout — a fetch that aborts (AbortController) after `ms`, so a
//     stalled external call (Anthropic, Google) rejects instead of blocking forever.
//     Callers catch the rejection and fall back deterministically.
//
//   withDeadline — races a promise against a timer; if the promise hasn't settled
//     by `ms`, it rejects with `message`. The underlying work may keep running in
//     the background function, but the job is guaranteed a terminal outcome.

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
