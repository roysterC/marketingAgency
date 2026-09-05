/**
 * One purchase per distinct request, however many targets ask for it.
 *
 * Most sources are bought per business: a Places lookup, a site crawl, a response-time
 * test. Two are not. A map pack query returns the subject *and* every competitor in one
 * response, and so does an AI answer to "best plumber in Wandsworth" — the request is
 * scan-level even though the capture is per-target.
 *
 * Left alone, the §2.2 fan-out over six targets buys those responses six times. This is
 * the mechanism that stops it. It is small, and every detail in it is one that is easy to
 * get wrong:
 *
 * - Concurrent callers share the in-flight request instead of racing into two purchases
 * - Only the first caller is charged. The rest cost nothing, which is what
 *   `collector_runs.cost_pence` should record, because it is what happened
 * - A failed request is evicted, so a later target retries rather than inheriting an error
 *   from whoever asked first
 *
 * One cache per scan. Sharing one across scans would serve yesterday's answers.
 */

import { FREE, type Priced } from '../resolve/providers';

export function createScanCache<Request, Response>(
  fetch: (request: Request) => Promise<Priced<Response>>,
  keyOf: (request: Request) => string,
): (request: Request) => Promise<Priced<Response>> {
  const pending = new Map<string, Promise<Priced<Response>>>();
  const charged = new Set<string>();

  return async (request: Request): Promise<Priced<Response>> => {
    const key = keyOf(request);

    let inflight = pending.get(key);
    if (!inflight) {
      inflight = fetch(request).catch((cause: unknown) => {
        pending.delete(key);
        throw cause;
      });
      pending.set(key, inflight);
    }

    const { value, cost } = await inflight;
    if (charged.has(key)) return { value, cost: FREE };
    charged.add(key);
    return { value, cost };
  };
}
