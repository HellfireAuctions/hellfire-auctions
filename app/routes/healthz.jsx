import prisma from "../db.server";
import { connectionCount } from "../live-hub.server";
import { selfTestStatus } from "../self-test.server";

// /healthz        -> quick "the server is up" check (never touches the database).
// /healthz?deep=1 -> also checks the database, the auction worker, overdue auctions and email failures.
//                    The database part is cached for 15 minutes so an uptime monitor can ping every 5 minutes
//                    without keeping a free-tier database awake all day.
export const loader = async ({ request }) => {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  if (!deep) return Response.json({ ok: true, service: "hellfire-auctions" });

  const problems = [];
  const cached = globalThis.__HF_DEEP_DB__;
  if (cached && Date.now() - cached.at < 15 * 60_000) {
    problems.push(...cached.problems);
  } else {
    const dbProblems = [];
    try {
      const overdue = await prisma.auction.count({
        where: {
          endsAt: { lt: new Date(Date.now() - 5 * 60_000) },
          status: { in: ["LIVE", "UPCOMING", "DRAFT", "SETTLING", "SETTLEMENT_RETRY"] },
        },
      });
      if (overdue > 0) dbProblems.push(`${overdue} auction(s) are past their end time and not settled`);
    } catch {
      dbProblems.push("database not reachable");
    }
    globalThis.__HF_DEEP_DB__ = { at: Date.now(), problems: dbProblems };
    problems.push(...dbProblems);
  }
  const lastTick = globalThis.__HF_LAST_TICK__ || 0;
  if (lastTick && Date.now() - lastTick > 10 * 60_000) problems.push("auction worker has not run for 10+ minutes");
  const robot = selfTestStatus();
  if (robot.ok === false) problems.push(`self-test failing: ${robot.failures.slice(0, 3).join("; ")}`);
  if (robot.at && Date.now() - robot.at > 40 * 60_000) problems.push("self-test has not run for 40+ minutes");
  const fails = globalThis.__HF_EMAIL_FAILS__ || 0;
  if (fails >= 5) problems.push(`${fails} email sends failed in a row`);

  // The details help when something looks wrong: how long ago the worker last finished a pass, how many shoppers are
  // on the live connection, how long the server has been up, and which version is running.
  return Response.json(
    {
      ok: problems.length === 0,
      problems,
      workerAgeSeconds: lastTick ? Math.round((Date.now() - lastTick) / 1000) : null,
      liveViewers: connectionCount(),
      uptimeSeconds: Math.round(process.uptime()),
      version: (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null,
      selfTest: robot.at ? { ok: robot.ok, ageSeconds: Math.round((Date.now() - robot.at) / 1000), checks: robot.checks, ms: robot.ms, failures: robot.failures } : null,
    },
    { status: problems.length ? 503 : 200 },
  );
};
