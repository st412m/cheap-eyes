// The built-in probe: a made-up scheduler log of 60 lines and a fixed extract task
// whose answer is known. A model is picked only after it returns exactly these lines,
// each quoted verbatim, without extra lines and without being cut off. The text holds
// no secret, no address and no real host name, so masking leaves it unchanged.

export const PROBE_FILE = 'cheap-eyes-probe.log';

export const PROBE_LINES = [
  '04:00:13 scheduler[201]: job=compact-east step=copy status=OK items=57 ms=263',
  '04:01:26 scheduler[202]: job=index-west step=verify status=OK items=94 ms=376',
  '04:02:39 scheduler[203]: job=mirror-south step=done status=OK items=131 ms=489',
  '04:03:52 scheduler[204]: job=sweep-cache step=start status=OK items=168 ms=602',
  '04:04:05 scheduler[205]: job=rotate-logs step=copy status=SKIPPED items=205 ms=715',
  '04:05:18 scheduler[206]: job=archive-north step=verify status=OK items=242 ms=828',
  '04:06:31 scheduler[207]: job=compact-east step=done status=OK items=279 ms=941',
  '04:07:44 scheduler[208]: job=index-west step=start status=OK items=316 ms=1054',
  '04:08:57 scheduler[200]: job=mirror-south step=copy status=FAILED items=353 ms=1167',
  '04:09:10 scheduler[201]: job=sweep-cache step=verify status=OK items=390 ms=1280',
  '04:10:23 scheduler[202]: job=rotate-logs step=done status=OK items=427 ms=1393',
  '04:11:36 scheduler[203]: job=archive-north step=start status=RETRY items=464 ms=1506',
  '04:12:49 scheduler[204]: job=compact-east step=copy status=OK items=501 ms=1619',
  '04:13:02 scheduler[205]: job=index-west step=verify status=OK items=38 ms=1732',
  '04:14:15 scheduler[206]: job=mirror-south step=done status=OK items=75 ms=1845',
  '04:15:28 scheduler[207]: job=sweep-cache step=start status=OK items=112 ms=1958',
  '04:16:41 scheduler[208]: job=rotate-logs step=copy status=FAILED items=149 ms=2071',
  '04:17:54 scheduler[200]: job=archive-north step=verify status=OK items=186 ms=2184',
  '04:18:07 scheduler[201]: job=compact-east step=done status=OK items=223 ms=2297',
  '04:19:20 scheduler[202]: job=index-west step=start status=OK items=260 ms=2410',
  '04:20:33 scheduler[203]: job=mirror-south step=copy status=OK items=297 ms=2523',
  '04:21:46 scheduler[204]: job=sweep-cache step=verify status=OK items=334 ms=2636',
  '04:22:59 scheduler[205]: job=rotate-logs step=done status=SKIPPED items=371 ms=2749',
  '04:23:12 scheduler[206]: job=archive-north step=start status=OK items=408 ms=2862',
  '04:24:25 scheduler[207]: job=compact-east step=copy status=OK items=445 ms=2975',
  '04:25:38 scheduler[208]: job=index-west step=verify status=OK items=482 ms=3088',
  '04:26:51 scheduler[200]: job=mirror-south step=done status=OK items=519 ms=3201',
  '04:27:04 scheduler[201]: job=sweep-cache step=start status=OK items=56 ms=3314',
  '04:28:17 scheduler[202]: job=rotate-logs step=copy status=OK items=93 ms=3427',
  '04:29:30 scheduler[203]: job=archive-north step=verify status=FAILED items=130 ms=3540',
  '04:30:43 scheduler[204]: job=compact-east step=done status=OK items=167 ms=3653',
  '04:31:56 scheduler[205]: job=index-west step=start status=OK items=204 ms=3766',
  '04:32:09 scheduler[206]: job=mirror-south step=copy status=OK items=241 ms=3879',
  '04:33:22 scheduler[207]: job=sweep-cache step=verify status=OK items=278 ms=3992',
  '04:34:35 scheduler[208]: job=rotate-logs step=done status=OK items=315 ms=4105',
  '04:35:48 scheduler[200]: job=archive-north step=start status=OK items=352 ms=4218',
  '04:36:01 scheduler[201]: job=compact-east step=copy status=OK items=389 ms=4331',
  '04:37:14 scheduler[202]: job=index-west step=verify status=SKIPPED items=426 ms=4444',
  '04:38:27 scheduler[203]: job=mirror-south step=done status=OK items=463 ms=4557',
  '04:39:40 scheduler[204]: job=sweep-cache step=start status=OK items=500 ms=4670',
  '04:40:53 scheduler[205]: job=rotate-logs step=copy status=RETRY items=37 ms=4783',
  '04:41:06 scheduler[206]: job=archive-north step=verify status=OK items=74 ms=4896',
  '04:42:19 scheduler[207]: job=compact-east step=done status=OK items=111 ms=5009',
  '04:43:32 scheduler[208]: job=index-west step=start status=FAILED items=148 ms=5122',
  '04:44:45 scheduler[200]: job=mirror-south step=copy status=OK items=185 ms=5235',
  '04:45:58 scheduler[201]: job=sweep-cache step=verify status=OK items=222 ms=5348',
  '04:46:11 scheduler[202]: job=rotate-logs step=done status=OK items=259 ms=5461',
  '04:47:24 scheduler[203]: job=archive-north step=start status=OK items=296 ms=5574',
  '04:48:37 scheduler[204]: job=compact-east step=copy status=OK items=333 ms=5687',
  '04:49:50 scheduler[205]: job=index-west step=verify status=OK items=370 ms=5800',
  '04:50:03 scheduler[206]: job=mirror-south step=done status=OK items=407 ms=5913',
  '04:51:16 scheduler[207]: job=sweep-cache step=start status=FAILED items=444 ms=6026',
  '04:52:29 scheduler[208]: job=rotate-logs step=copy status=OK items=481 ms=6139',
  '04:53:42 scheduler[200]: job=archive-north step=verify status=OK items=518 ms=6252',
  '04:54:55 scheduler[201]: job=compact-east step=done status=OK items=55 ms=6365',
  '04:55:08 scheduler[202]: job=index-west step=start status=OK items=92 ms=6478',
  '04:56:21 scheduler[203]: job=mirror-south step=copy status=RETRY items=129 ms=6591',
  '04:57:34 scheduler[204]: job=sweep-cache step=verify status=OK items=166 ms=6704',
  '04:58:47 scheduler[205]: job=rotate-logs step=done status=OK items=203 ms=6817',
  '04:59:00 scheduler[206]: job=archive-north step=start status=OK items=240 ms=6930',
];

export const PROBE_TASK = 'Quote every line whose status is FAILED.';

// 1-based line numbers of the FAILED lines.
export const PROBE_EXPECTED = [9, 17, 30, 44, 52];

export const PROBE_TEXT = PROBE_LINES.join('\n') + '\n';

// Up to this many output tokens per probe call: the answer is five short lines.
export const PROBE_MAX_TOKENS = 2048;
// One probe call, without retries: a slow or failing candidate is recorded as failed
// and the next one is tried, so a pick stays within a few minutes.
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * Verdict on a finished probe job (the result of the normal extract pipeline):
 * every expected line, each check item "ok", nothing else, nothing truncated.
 * Returns { ok, reason }.
 */
export function probeVerdict(res) {
  if (res.status !== 'done') return { ok: false, reason: res.error ?? res.status };
  if (res.rec.truncated || res.rec.resplit) return { ok: false, reason: 'answer cut off (finish_reason length)' };
  const items = res.checks.items;
  const notOk = items.filter((it) => it.status !== 'ok');
  if (notOk.length) return { ok: false, reason: `check: ${notOk.length} line(s) not quoted verbatim (${[...new Set(notOk.map((it) => it.status))].join(', ')})` };
  const got = items.map((it) => it.line);
  const missing = PROBE_EXPECTED.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !PROBE_EXPECTED.includes(n));
  if (missing.length || extra.length) {
    return { ok: false, reason: [missing.length ? `missing L${missing.join(', L')}` : '', extra.length ? `extra L${extra.join(', L')}` : ''].filter(Boolean).join('; ') };
  }
  return { ok: true, reason: null };
}
