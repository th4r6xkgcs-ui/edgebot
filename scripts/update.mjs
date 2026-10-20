// EdgeBot hourly update (runs in GitHub Actions; no API keys, no Claude).
// Reads ESPN's public scoreboards, learns from finals, saves/grades picks, writes data/*.json for the app.
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const E = require(path.join(ROOT, "engine.js"));
const DATA = path.join(ROOT, "data");
const now = new Date(process.env.EDGEBOT_NOW || Date.now()), NOW = now.getTime();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(path.join(DATA, f)), { recursive: true }); fs.writeFileSync(path.join(DATA, f), JSON.stringify(v)); };

const SEASON_START = { NBA: "2026-10-20", NHL: "2026-10-06", NFL: "2026-09-10", NCAAF: "2026-08-29", MLB: "2026-03-26", EPL: "2026-08-15" };
const PATHS = { NBA: "basketball/nba", NHL: "hockey/nhl", MLB: "baseball/mlb", NFL: "football/nfl", NCAAF: "football/college-football", EPL: "soccer/eng.1" };
const etDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const ymd = (d) => d.replaceAll("-", "");
const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

let requests = 0; const failures = [];
async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      requests++;
      const r = await fetch(url, { headers: { "User-Agent": "EdgeBot/2 (personal research)" }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { if (attempt === 2) { failures.push(`${url.split("/sports/")[1]}: ${e.message}`); return null; } await new Promise((s) => setTimeout(s, 800 * (attempt + 1))); }
  }
}
const num = (x) => { if (x === null || x === undefined || x === "") return null; const v = typeof x === "string" ? parseFloat(x.replace(/^EVEN$/i, "100")) : +x; return isFinite(v) ? v : null; };
/** One ESPN event -> engine game (or null). */
export function parseEvent(sport, ev) {
  const c = ev?.competitions?.[0]; if (!c) return null;
  const home = c.competitors?.find((x) => x.homeAway === "home"), away = c.competitors?.find((x) => x.homeAway === "away");
  if (!home?.team || !away?.team) return null;
  const state = ev.status?.type?.state ?? c.status?.type?.state, completed = ev.status?.type?.completed ?? c.status?.type?.completed;
  let status = state === "post" ? (completed ? "post" : "unknown") : state === "in" ? "in" : state === "pre" ? "pre" : "unknown";
  if (/postponed|canceled|cancelled|suspended/i.test(ev.status?.type?.name || "")) status = "unknown";
  const team = (t) => ({ abbr: t.team.abbreviation || t.team.shortDisplayName, name: t.team.displayName || t.team.name, score: status === "pre" ? null : num(t.score) });
  const g = { id: `${sport}:${ev.id}`, sport, start: new Date(ev.date).toISOString(), status, home: team(home), away: team(away),
    spread: null, total: null, mlHome: null, mlAway: null, mlDraw: null, source: "ESPN scoreboard" };
  if (status === "post" && (g.home.score == null || g.away.score == null)) g.status = "unknown";
  const o = c.odds?.[0];
  if (o) {
    g.total = num(o.overUnder) ?? num(o.total?.over?.close?.line?.replace?.(/^[ou]/i, ""));
    g.mlHome = num(o.homeTeamOdds?.moneyLine) ?? num(o.moneyline?.home?.close?.odds) ?? num(o.moneyline?.home?.open?.odds);
    g.mlAway = num(o.awayTeamOdds?.moneyLine) ?? num(o.moneyline?.away?.close?.odds) ?? num(o.moneyline?.away?.open?.odds);
    g.mlDraw = num(o.drawOdds?.moneyLine) ?? num(o.moneyline?.draw?.close?.odds);
    if (sport !== "EPL") {
      const homeLine = num(o.pointSpread?.home?.close?.line) ?? num(o.pointSpread?.home?.open?.line);
      if (homeLine != null) g.spread = homeLine;
      else {
        const m = /^([A-Z0-9&.]+)\s+([-+]?\d+(\.\d+)?)$/i.exec((o.details || "").trim()), mag = m ? Math.abs(+m[2]) : Math.abs(num(o.spread) ?? NaN);
        let fav = o.homeTeamOdds?.favorite ? "home" : o.awayTeamOdds?.favorite ? "away" : null;
        if (!fav && m) fav = m[1].toUpperCase() === String(g.home.abbr).toUpperCase() ? "home" : m[1].toUpperCase() === String(g.away.abbr).toUpperCase() ? "away" : null;
        if (/^even$/i.test((o.details || "").trim())) g.spread = 0;
        else if (fav && isFinite(mag)) g.spread = fav === "home" ? -mag : mag;
      }
    }
  }
  if (g.status === "pre" && Date.parse(g.start) < NOW - 6 * 3600e3) g.status = "unknown"; // stale feed: no picks, no learning
  return g;
}
async function scoreboard(sport, date) {
  const q = new URLSearchParams({ limit: "300" }); if (date) q.set("dates", ymd(date)); if (sport === "NCAAF") q.set("groups", "80");
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/scoreboard?${q}`);
  return (d?.events || []).map((ev) => parseEvent(sport, ev)).filter(Boolean);
}

async function main() {
  const today = etDate(NOW), fetched = readJson("state/fetched.json", {}), month = +today.slice(5, 7);
  const jobs = [];
  for (const s of ["NBA", "NHL"]) for (const n of [-1, 0, 1, 2]) jobs.push([s, addDays(today, n)]);
  if (month >= 3 && month <= 11) for (const n of [-1, 0, 1]) jobs.push(["MLB", addDays(today, n)]);
  for (const s of ["NFL", "NCAAF", "EPL"]) { jobs.push([s, null]); for (const n of [-3, -2, -1, 1, 2, 3, 4, 5, 6]) jobs.push([s, addDays(today, n)]); }
  // backfill: walk back from the oldest fetched date toward season start, a few dates per run
  for (const s of ["NBA", "NHL", "NFL", "NCAAF", "EPL"]) {
    let d = fetched[s] ? addDays(fetched[s], -1) : addDays(today, -4), k = 0;
    while (k < (s === "NFL" || s === "NCAAF" || s === "EPL" ? 7 : 4) && d >= SEASON_START[s]) { jobs.push([s, d, true]); fetched[s] = d; d = addDays(d, -1); k++; }
  }
  const games = new Map();
  for (let i = 0; i < jobs.length; i += 6) {
    const chunk = await Promise.all(jobs.slice(i, i + 6).map(([s, d]) => scoreboard(s, d)));
    for (const list of chunk) for (const g of list) { const prev = games.get(g.id); if (!prev || g.status === "post" || (prev.status !== "post" && g.spread != null)) games.set(g.id, g); }
  }
  const ratings = {}; for (const s of Object.keys(E.SPORTS)) { const r = readJson(`ratings/${s}.json`, null); if (r) ratings[s] = r; }
  const model = readJson("state/model.json", {}), ledger = readJson("ledger.json", []);
  const out = E.runCycle({ now: now.toISOString(), games: [...games.values()], ratings, model, openLedger: ledger.filter((r) => r.status === "open"), ledgerIds: ledger.map((r) => r.id) });
  const byId = new Map(ledger.map((r) => [r.id, r]));
  for (const gr of out.graded) Object.assign(byId.get(gr.id), { status: "graded", result: gr.result, final: gr.final, gradedAt: gr.gradedAt, units: gr.units });
  // picks whose game vanished or never finished: void after 4 days (never counted)
  for (const r of ledger) if (r.status === "open" && Date.parse(r.start) < NOW - 4 * 864e5) Object.assign(r, { status: "void", note: "No verified final found." });
  ledger.push(...out.newPicks);
  const runs = readJson("runs.json", []);
  const log = [...out.log, `${requests} ESPN requests${failures.length ? `, ${failures.length} failed` : ""}.`];
  runs.unshift({ at: now.toISOString(), summary: out.model.lastSummary, log, failures: failures.slice(0, 5) }); runs.length = Math.min(runs.length, 60);
  for (const s of out.touched) writeJson(`ratings/${s}.json`, out.ratings[s]);
  writeJson("state/model.json", out.model); writeJson("state/fetched.json", fetched); writeJson("ledger.json", ledger); writeJson("runs.json", runs);
  writeJson("app.json", { at: now.toISOString(), slate: { at: now.toISOString(), games: out.slate }, model: out.model,
    ledger: [...ledger].sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || "")).slice(0, 800), runs: runs.slice(0, 15) });
  console.log(log.join("\n")); if (failures.length) console.log("Failures:\n" + failures.slice(0, 10).join("\n"));
  if (requests && failures.length === requests) process.exit(1); // every request failed: mark the run red
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
