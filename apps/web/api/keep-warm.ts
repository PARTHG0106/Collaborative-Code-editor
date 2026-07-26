/**
 * Keep-warm ping.
 *
 * The API is hosted on a free Hugging Face Space, which sleeps after a period
 * of inactivity and then takes roughly 35 seconds to boot. That cold start is
 * the first thing a visitor experiences on the login screen. Hitting a cheap
 * health route on a schedule keeps the container resident.
 *
 * Point an external scheduler (UptimeRobot, cron-job.org, a GitHub Actions
 * schedule) at /api/keep-warm every 5 minutes. Vercel Hobby cron frequency is
 * too coarse to be useful for this.
 *
 * /health/ping is deliberately chosen because it does not touch the database.
 */
export const config = { runtime: 'edge' };

const DEFAULT_PING_URL = 'https://parthg0106-syncscript-api.hf.space/api/health/ping';

export default async function handler(): Promise<Response> {
  const target = process.env.API_PING_URL || DEFAULT_PING_URL;
  const startedAt = Date.now();

  try {
    const res = await fetch(target, {
      method: 'GET',
      headers: { 'user-agent': 'syncscript-keep-warm' },
      signal: AbortSignal.timeout(60_000),
    });

    return new Response(
      JSON.stringify({
        ok: res.ok,
        status: res.status,
        durationMs: Date.now() - startedAt,
        target,
      }),
      {
        status: res.ok ? 200 : 502,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        target,
      }),
      {
        status: 504,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
}
