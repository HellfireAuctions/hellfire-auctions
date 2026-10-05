/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { readAuctionRows, CSV_TEMPLATE } from "./csv-import";
import { checkBatchTimes, planBatch } from "./event-schedule";

const input = { padding: "8px 10px", border: "1px solid #8a8a8a", borderRadius: 8 };

// Each auction goes through the same create step as the form, one after another.
function jobFormData(job, row, relist) {
  const fd = new FormData();
  fd.set("intent", "create");
  fd.set("title", row.title);
  fd.set("description", row.description);
  fd.set("startingBid", String(row.startingBid));
  if (row.reservePrice != null) fd.set("reservePrice", String(row.reservePrice));
  fd.set("customStartLocal", job.startLocal);
  fd.set("customEndLocal", job.endLocal);
  fd.set("cloneImageUrl", row.imageUrl);
  if (row.weightValue) {
    fd.set("weightValue", String(row.weightValue));
    fd.set("weightUnit", row.weightUnit);
  }
  fd.set("autoRelist", relist);
  return fd;
}

export default function BulkImport({ timezone }) {
  const fetcher = useFetcher();
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState(null);
  const [startLocal, setStartLocal] = useState("");
  const [firstEndLocal, setFirstEndLocal] = useState("");
  const [gap, setGap] = useState("8");
  const [weeks, setWeeks] = useState("1");
  const [relist, setRelist] = useState("0");
  const [jobs, setJobs] = useState([]);
  const [pos, setPos] = useState(-1); // the auction being created; -1 = idle
  const [results, setResults] = useState([]);
  const [stopped, setStopped] = useState("");
  const sent = useRef(-1);

  const valid = parsed ? parsed.rows.filter((r) => !r.problems.length).map((r) => r.data) : [];
  const badRows = parsed ? parsed.rows.filter((r) => r.problems.length) : [];
  const times = { count: valid.length, startLocal, firstEndLocal, gapMinutes: Number(gap), weeks: Number(weeks) };
  const timesProblem = parsed && valid.length ? checkBatchTimes(times) : null;
  const running = pos >= 0;
  const canStart = parsed && !parsed.missingColumns.length && valid.length > 0 && !timesProblem && !running;
  const total = valid.length * Number(weeks || 1);

  useEffect(() => {
    if (pos < 0 || fetcher.state !== "idle") return;
    if (sent.current === pos) {
      const d = fetcher.data;
      const ok = d?.mode === "create" && d?.success === true;
      const message = ok ? "" : String(d?.error || "Something went wrong.");
      setResults((r) => [...r, { pos, ok, message }]);
      sent.current = -1;
      if (!ok && /used all/i.test(message)) {
        setStopped(message);
        setPos(-1);
        return;
      }
      if (pos + 1 < jobs.length) setPos(pos + 1);
      else setPos(-1);
      return;
    }
    sent.current = pos;
    fetcher.submit(jobFormData(jobs[pos], valid[jobs[pos].index], relist), { method: "post", encType: "multipart/form-data" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, fetcher.state, fetcher.data]);

  const start = () => {
    setResults([]);
    setStopped("");
    setJobs(planBatch(times));
    sent.current = -1;
    setPos(0);
  };

  const finished = !running && results.length > 0;
  const created = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  const titleFor = (job) => (job ? valid[job.index]?.title : "");

  return (
    <details style={{ background: "#fff", border: "1px solid #e3e3e3", borderRadius: 12, padding: "14px 18px", margin: "16px 0" }}>
      <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 15 }}>Create many auctions from a spreadsheet (CSV)</summary>
      <div style={{ display: "grid", gap: 14, marginTop: 14, fontSize: 14, lineHeight: 1.5 }}>
        <div>
          Make one row per item in Excel or Google Sheets, save it as <strong>CSV</strong>, and upload it here. Each row needs a <strong>title</strong>, a <strong>starting bid</strong> and a <strong>photo link</strong> (a web address starting with https://). A description, a reserve price and a shipping weight are optional.{" "}
          <a href={"data:text/csv;charset=utf-8," + encodeURIComponent(CSV_TEMPLATE)} download="hellfire-auctions-template.csv">Download a template</a>
        </div>

        <input
          type="file"
          accept=".csv,text/csv"
          disabled={running}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setFileName(file.name);
            setResults([]);
            setStopped("");
            setParsed(readAuctionRows(await file.text()));
          }}
        />

        {parsed && parsed.missingColumns.length > 0 && (
          <div style={{ color: "#b42318" }}>
            This file is missing a column: {parsed.missingColumns.map((c) => ({ title: "title", startingBid: "starting bid", imageUrl: "image url" }[c] || c)).join(", ")}. Download the template to see the layout.
          </div>
        )}

        {parsed && !parsed.missingColumns.length && (
          <div style={{ display: "grid", gap: 8 }}>
            <div>
              <strong>{fileName}:</strong> {valid.length} row{valid.length === 1 ? "" : "s"} ready{badRows.length ? `, ${badRows.length} with problems (they will be skipped)` : ""}.
              {parsed.tooMany && <span style={{ color: "#b42318" }}> Only the first 100 rows are used.</span>}
            </div>
            {badRows.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20, color: "#b42318" }}>
                {badRows.slice(0, 8).map((r) => (
                  <li key={r.line}>Row {r.line}: {r.problems.join("; ")}</li>
                ))}
                {badRows.length > 8 && <li>…and {badRows.length - 8} more</li>}
              </ul>
            )}
            {valid.length > 0 && (
              <ol style={{ margin: 0, paddingLeft: 20, color: "#303030" }}>
                {valid.slice(0, 5).map((r, i) => (
                  <li key={i}>{r.title} &middot; starts at ${r.startingBid}{r.reservePrice != null ? ` \u00b7 reserve $${r.reservePrice}` : ""}</li>
                ))}
                {valid.length > 5 && <li>…and {valid.length - 5} more</li>}
              </ol>
            )}
          </div>
        )}

        {parsed && !parsed.missingColumns.length && valid.length > 0 && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>All auctions start</strong>
                <input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} disabled={running} style={input} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>First auction ends</strong>
                <input type="datetime-local" value={firstEndLocal} onChange={(e) => setFirstEndLocal(e.target.value)} disabled={running} style={input} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>Minutes between endings</strong>
                <input type="number" min="1" max="1440" value={gap} onChange={(e) => setGap(e.target.value)} disabled={running} style={{ ...input, width: 120 }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>Repeat every week for</strong>
                <select value={weeks} onChange={(e) => setWeeks(e.target.value)} disabled={running} style={input}>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={String(n)}>{n === 1 ? "1 week (no repeat)" : `${n} weeks`}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <strong>If an item doesn&rsquo;t sell</strong>
                <select value={relist} onChange={(e) => setRelist(e.target.value)} disabled={running} style={input}>
                  <option value="0">Don&rsquo;t relist</option>
                  <option value="1">Relist it once</option>
                  <option value="2">Relist it up to 2 times</option>
                  <option value="3">Relist it up to 3 times</option>
                </select>
              </label>
            </div>
            <span style={{ fontSize: 13, color: "#616161" }}>
              Times are in your store&rsquo;s time zone ({timezone}). Lots end one after another in the order of your spreadsheet. A repeat keeps the same day and time each week.
            </span>
            {timesProblem && startLocal && firstEndLocal && <div style={{ color: "#b42318" }}>{timesProblem}</div>}
            {canStart && (
              <div>
                <strong>{total} auction{total === 1 ? "" : "s"}</strong> will be created{Number(weeks) > 1 ? ` (${valid.length} lots, ${weeks} weeks)` : ""}. Each one counts toward your plan&rsquo;s monthly limit.
              </div>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <s-button variant="primary" disabled={!canStart || undefined} onClick={canStart ? start : undefined}>
                {running ? "Creating…" : `Create ${total} auction${total === 1 ? "" : "s"}`}
              </s-button>
              {running && <s-button variant="secondary" onClick={() => setPos(-1)}>Stop after this one</s-button>}
            </div>
          </div>
        )}

        {running && (
          <div role="status" style={{ background: "#fff8e1", border: "1px solid #ffd60a", borderRadius: 10, padding: "10px 14px" }}>
            Creating {Math.min(pos + 1, jobs.length)} of {jobs.length}: <strong>{titleFor(jobs[pos])}</strong>. Keep this page open until it finishes.
          </div>
        )}
        {stopped && <div style={{ color: "#b42318" }}>Stopped early: {stopped}</div>}
        {finished && (
          <div role="status" style={{ background: failures.length ? "#fff4f4" : "#e8f5e9", border: `1px solid ${failures.length ? "#f1b0a8" : "#b7dfc9"}`, borderRadius: 10, padding: "10px 14px" }}>
            <strong>Created {created} of {results.length} auction{results.length === 1 ? "" : "s"}.</strong>
            {failures.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {failures.slice(0, 10).map((f) => (
                  <li key={f.pos}>{titleFor(jobs[f.pos])}: {f.message}</li>
                ))}
                {failures.length > 10 && <li>…and {failures.length - 10} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
