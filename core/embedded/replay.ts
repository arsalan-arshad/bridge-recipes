// Which failed jobs a shop may replay from the embedded page. Pure. A shop can only ever replay ITS OWN jobs (the operator admin's
// "replay all" is global; this is deliberately narrower), and a job id from the request is only honoured if it is one of them.

const UUID = /^[0-9a-fA-F-]{36}$/;

export type ReplaySelection = { ok: true; ids: string[] } | { ok: false };

export function selectReplayIds(jobs: { id: string; shop: string }[], shop: string, requested: string | undefined): ReplaySelection {
  const own = jobs.filter((j) => j.shop === shop).map((j) => j.id);
  if (requested === 'all') return { ok: true, ids: own };
  if (requested === undefined || !UUID.test(requested)) return { ok: false };
  return { ok: true, ids: own.includes(requested) ? [requested] : [] };
}
