import prisma from "../db.server";

// /healthz        -> quick "the server is up" check.
// /healthz?deep=1 -> also checks the database, the auction worker, overdue auctions and email failures.
//                    Returns 503 with the problems listed, so an uptime monitor can alert you.
export const loader = async ({ request }) => {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  if (!deep) return Response.json({ ok: true, service: "hellfire-auctions" });

  const problems = [];
  try {
    const overdue = await prisma.auction.count({
      where: {
        endsAt: { lt: new Date(Date.now() - 5 * 60_000) },
        status: { in: ["LIVE", "UPCOMING", "DRAFT", "SETTLING", "SETTLEMENT_RETRY"] },
      },
    });
    if (overdue > 0) problems.push(`${overdue} auction(s) are past their end time and not settled`);
  } catch {
    problems.push("database not reachable");
  }
  const lastTick = globalThis.__HF_LAST_TICK__ || 0;
  if (lastTick && Date.now() - lastTick > 45 * 60_000) problems.push("auction worker has not run for 45+ minutes");
  const fails = globalThis.__HF_EMAIL_FAILS__ || 0;
  if (fails >= 5) problems.push(`${fails} email sends failed in a row`);

  return Response.json({ ok: problems.length === 0, problems }, { status: problems.length ? 503 : 200 });
};
