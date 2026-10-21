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
// Last completed season per sport (for preseason ratings), fetched backwards a little each run.
const PREV_SEASON = { NBA: ["2025-10-21", "2026-06-22"], NHL: ["2025-10-07", "2026-06-25"], NCAAF: ["2025-08-23", "2026-01-20"], EPL: ["2025-08-15", "2026-05-24"] };
const HISTORY_REQUESTS_PER_RUN = 120;
// Outdoor (or retractable-roof) NFL stadiums for wind forecasts — nflverse stadium ids.
const STADIUMS = { BAL00: [39.278, -76.623], BOS00: [42.091, -71.264], BUF00: [42.774, -78.787], CAR00: [35.226, -80.853], CHI98: [41.862, -87.617], CIN00: [39.095, -84.516],
  CLE00: [41.506, -81.700], DEN00: [39.744, -105.020], GNB00: [44.501, -88.062], JAX00: [30.324, -81.637], KAN00: [39.049, -94.484], MIA00: [25.958, -80.239], NAS00: [36.166, -86.771],
  NYC01: [40.814, -74.074], PHI00: [39.901, -75.168], PIT00: [40.447, -80.016], SEA00: [47.595, -122.332], SFO01: [37.403, -121.970], TAM00: [27.976, -82.503], WAS00: [38.908, -76.864],
  LON00: [51.556, -0.280], LON02: [51.604, -0.066], MEX00: [19.303, -99.150], ATL97: [33.755, -84.401], IND00: [39.760, -86.164], PHO00: [33.528, -112.263], DAL00: [32.748, -97.093], HOU00: [29.685, -95.411] };
const NFLVERSE_ABBR = { LA: "LAR", WAS: "WSH" };
const PATHS = { NBA: "basketball/nba", NHL: "hockey/nhl", MLB: "baseball/mlb", NFL: "football/nfl", NCAAF: "football/college-football", EPL: "soccer/eng.1" };
const etDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const ymd = (d) => d.replaceAll("-", "");
const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

let requests = 0, failed = 0; const failures = [];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
async function getJson(url) {
  requests++;
  const hosts = [url, url.replace("https://site.api.espn.com/", "https://site.web.api.espn.com/")];
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const u = hosts[attempt % 2];
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.espn.com/" }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e.message; await new Promise((s) => setTimeout(s, 700 * (attempt + 1))); }
  }
  failed++; failures.push(`${url.split("/sports/")[1]}: ${last}`); return null;
}
async function getText(url) {
  requests++;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.text(); }
    catch (e) { if (attempt === 2) { failed++; failures.push(`${url.slice(0, 80)}: ${e.message}`); return null; } await new Promise((s) => setTimeout(s, 1000 * (attempt + 1))); }
  }
}
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || []; return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const normStatus = (s) => /^out|injured reserve|^ir\b|suspen/i.test(s) ? "OUT" : /doubt/i.test(s) ? "DOUBTFUL" : /question/i.test(s) ? "QUESTIONABLE" : /day.to.day|probable/i.test(s) ? "DAY_TO_DAY" : "OTHER";
/** ESPN league injury report -> { teamDisplayName: [{name, pos, status, detail}] } (fresh reports only; rest designations dropped). */
async function injuries(sport) {
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/injuries`); const out = {};
  for (const team of d?.injuries || []) for (const e of team.injuries || []) {
    const name = e.athlete?.displayName, raw = String(e.status ?? e.type?.description ?? ""), detail = [e.details?.type, e.details?.detail].filter(Boolean).join(" ") || String(e.shortComment || "").slice(0, 120);
    if (!team.displayName || !name || /\brest\b|load management|not injury related/i.test(detail + " " + (e.shortComment || ""))) continue;
    const updated = Date.parse(e.date || ""), status = normStatus(raw);
    const fresh = (isFinite(updated) && NOW - updated <= 21 * 864e5) || (status === "OUT" && e.details?.returnDate && Date.parse(e.details.returnDate) > NOW);
    if (!fresh || status === "OTHER") continue;
    (out[team.displayName] ||= []).push({ name, pos: e.athlete?.position?.abbreviation || "", status, detail });
  }
  return out;
}
const num = (x) => { if (x === null || x === undefined || x === "") return null; const v = typeof x === "string" ? parseFloat(x.replace(/^EVEN$/i, "100")) : +x; return isFinite(v) ? v : null; };
const oddsSamples = {}; // one raw odds object per sport, saved for debugging field names
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
    g.spreadPriceHome = num(o.pointSpread?.home?.close?.odds) ?? num(o.homeTeamOdds?.spreadOdds) ?? null;
    g.spreadPriceAway = num(o.pointSpread?.away?.close?.odds) ?? num(o.awayTeamOdds?.spreadOdds) ?? null;
    g.overPrice = num(o.total?.over?.close?.odds) ?? num(o.overOdds) ?? null;
    g.underPrice = num(o.total?.under?.close?.odds) ?? num(o.underOdds) ?? null;
    if (!oddsSamples[sport]) oddsSamples[sport] = o;
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
  const q = new URLSearchParams(); if (date) q.set("dates", ymd(date)); if (sport === "NCAAF") q.set("groups", "80");
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/scoreboard?${q}`);
  return (d?.events || []).map((ev) => parseEvent(sport, ev)).filter(Boolean);
}

async function main() {
  // v2.2 migration: ratings now come from a finals archive, so re-walk this season once if the archive doesn't exist yet
  const firstArchiveRun = !fs.existsSync(path.join(DATA, "state", "archive"));
  const today = etDate(NOW), fetched = firstArchiveRun ? {} : readJson("state/fetched.json", {}), month = +today.slice(5, 7);
  const jobs = [];
  for (const s of ["NBA", "NHL"]) for (const n of [-1, 0, 1, 2]) jobs.push([s, addDays(today, n)]);
  if (month >= 3 && month <= 11) for (const n of [-1, 0, 1]) jobs.push(["MLB", addDays(today, n)]);
  for (const s of ["NFL", "NCAAF", "EPL"]) { jobs.push([s, null]); for (const n of [-3, -2, -1, 1, 2, 3, 4, 5, 6]) jobs.push([s, addDays(today, n)]); }
  // backfill: walk back from the oldest fetched date toward season start, a few dates per run
  for (const s of ["NBA", "NHL", "NFL", "NCAAF", "EPL"]) {
    let d = fetched[s] ? addDays(fetched[s], -1) : addDays(today, -4), k = 0;
    while (k < 70 && d >= SEASON_START[s]) { jobs.push([s, d, true]); fetched[s] = d; d = addDays(d, -1); k++; }
  }
  // last season (preseason ratings): walk backwards from the season's end, a capped number of dates per run
  const history = readJson("state/history.json", {}); let histBudget = HISTORY_REQUESTS_PER_RUN;
  // round-robin so every league gets its preseason history at the same pace
  for (let progressed = true; histBudget > 0 && progressed;) {
    progressed = false;
    for (const [s, [from, to]] of Object.entries(PREV_SEASON)) {
      const d = history[s] ? addDays(history[s], -1) : to;
      if (histBudget > 0 && d >= from) { jobs.push([s, d, true]); history[s] = d; histBudget--; progressed = true; }
    }
  }
  const games = new Map();
  for (let i = 0; i < jobs.length; i += 4) {
    const chunk = await Promise.all(jobs.slice(i, i + 4).map(([s, d]) => scoreboard(s, d)));
    for (const list of chunk) for (const g of list) { const prev = games.get(g.id); if (!prev || g.status === "post" || (prev.status !== "post" && g.spread != null)) games.set(g.id, g); }
  }
  // ---- archive of verified finals per sport (ratings are rebuilt from it every run, in date order) ----
  const archive = {}; for (const sp of Object.keys(E.SPORTS)) archive[sp] = readJson(`state/archive/${sp}.json`, []);
  // NFL history with closing lines, rest days and stadiums from nflverse (open data, CC-BY 4.0)
  const nflMeta = new Map();
  const csv = await getText("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv");
  if (csv) {
    const nv = parseCsv(csv).filter((r) => +r.season >= 2024), keep = [];
    for (const r of nv) {
      const h = NFLVERSE_ABBR[r.home_team] || r.home_team, a = NFLVERSE_ABBR[r.away_team] || r.away_team, id = r.espn ? `NFL:${r.espn}` : `NFL:nv-${r.game_id}`;
      const rest = { home: num(r.home_rest), away: num(r.away_rest) };
      nflMeta.set(id, { rest, stadium: r.stadium_id, roof: r.roof, neutral: r.location === "Neutral" });
      if (r.result !== "" && r.home_score !== "" && r.away_score !== "")
        keep.push({ id, d: new Date(`${r.gameday}T${(r.gametime || "13:00")}:00-05:00`).toISOString(), h, a, hs: +r.home_score, as: +r.away_score,
          sp: r.spread_line !== "" ? -(+r.spread_line) : null, tot: r.total_line !== "" ? +r.total_line : null, rest, n: r.location === "Neutral" ? 1 : 0 });
    }
    const ids = new Set(keep.map((x) => x.id)); archive.NFL = [...archive.NFL.filter((x) => !ids.has(x.id)), ...keep];
  }
  // ESPN drops odds once a game is final: remember each game's last pregame line (≈ closing line) and re-attach it.
  const lines = readJson("state/lines.json", {});
  for (const g of games.values()) {
    const PRICE_KEYS = ["spread", "total", "mlHome", "mlAway", "mlDraw", "spreadPriceHome", "spreadPriceAway", "overPrice", "underPrice"];
    if (g.status === "pre" && (g.spread != null || g.mlHome != null || g.total != null)) lines[g.id] = { ...Object.fromEntries(PRICE_KEYS.map((k) => [k, g[k] ?? null])), start: g.start, at: now.toISOString() };
    else if (g.status !== "pre" && lines[g.id] && g.spread == null && g.mlHome == null && g.total == null) { const L = lines[g.id]; for (const k of PRICE_KEYS) g[k] = L[k] ?? null; g.closingLine = true; }
  }
  for (const [id, L] of Object.entries(lines)) if (Date.parse(L.start) < NOW - 30 * 864e5) delete lines[id];
  writeJson("state/lines.json", lines);
  // add this run's verified finals (with their stored closing lines) to the archive
  let newFinals = 0;
  const archIdx = Object.fromEntries(Object.entries(archive).map(([sp, A]) => [sp, new Map(A.map((x, i) => [x.id, i]))]));
  for (const g of games.values()) if (g.status === "post" && g.home.score != null && g.away.score != null) {
    const A = archive[g.sport], i = archIdx[g.sport].get(g.id), row = { id: g.id, d: g.start, h: g.home.abbr, a: g.away.abbr, hs: g.home.score, as: g.away.score, sp: g.spread, tot: g.total };
    if (i == null) { archIdx[g.sport].set(g.id, A.length); A.push(row); newFinals++; } else if (A[i].sp == null && row.sp != null) A[i] = { ...A[i], sp: row.sp, tot: row.tot };
  }
  // context for upcoming games: rest days, NFL stadium/weather, injury reports
  const lastPlayed = {}; // sport|team -> sorted dates (ET) of games
  for (const [sp, A] of Object.entries(archive)) for (const x of A) { for (const t of [x.h, x.a]) (lastPlayed[`${sp}|${t}`] ||= []).push(etDate(Date.parse(x.d))); }
  for (const g of games.values()) for (const t of [g.home.abbr, g.away.abbr]) (lastPlayed[`${g.sport}|${t}`] ||= []).push(etDate(Date.parse(g.start)));
  for (const k of Object.keys(lastPlayed)) lastPlayed[k] = [...new Set(lastPlayed[k])].sort();
  const restFor = (sp, t, day) => { const L = lastPlayed[`${sp}|${t}`] || []; let prev = null; for (const d of L) { if (d < day) prev = d; else break; } return prev ? Math.round((Date.parse(day) - Date.parse(prev)) / 864e5) : null; };
  const injuryBooks = {};
  for (const sp of ["NBA", "NFL", "NHL"]) if ([...games.values()].some((g) => g.sport === sp && g.status === "pre")) injuryBooks[sp] = await injuries(sp);
  const weatherJobs = [];
  for (const g of games.values()) {
    if (g.status !== "pre") continue;
    const day = etDate(Date.parse(g.start));
    if (g.sport === "NBA" || g.sport === "NHL") g.restDays = { home: restFor(g.sport, g.home.abbr, day), away: restFor(g.sport, g.away.abbr, day) };
    if (g.sport === "NFL") {
      const m = nflMeta.get(g.id);
      if (m) { g.restDays = m.rest; g.neutral = m.neutral;
        const where = STADIUMS[m.stadium], outdoor = m.roof === "outdoors" || m.roof === "open";
        if (where && outdoor && Date.parse(g.start) - NOW < 6 * 864e5) weatherJobs.push([g, where]);
        else if (!outdoor && m.roof) g.weather = { outdoor: false, roof: m.roof };
      }
    }
    const book = injuryBooks[g.sport];
    if (book) g.injuries = { home: book[g.home.name] || [], away: book[g.away.name] || [] };
  }
  for (const [g, [lat, lon]] of weatherJobs) {
    const day = new Date(g.start).toISOString().slice(0, 10);
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_gusts_10m,temperature_2m,precipitation_probability&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&start_date=${day}&end_date=${day}`);
    const hour = new Date(g.start).getUTCHours(), H = w?.hourly;
    if (H?.time) { const i = H.time.findIndex((t) => +t.slice(11, 13) === hour); if (i >= 0) g.weather = { outdoor: true, windMph: H.wind_speed_10m[i], gustMph: H.wind_gusts_10m?.[i], tempF: H.temperature_2m?.[i], rainPct: H.precipitation_probability?.[i], source: "Open-Meteo forecast" }; }
  }
  // rebuild ratings from the archive (last season regressed 30% toward average, then this season)
  const ratings = {};
  for (const sp of Object.keys(E.SPORTS)) if (archive[sp].length) ratings[sp] = E.buildRatings(sp, archive[sp], SEASON_START[sp], now.toISOString());
  const model = readJson("state/model.json", {}), ledger = readJson("ledger.json", []);
  const out = E.runCycle({ now: now.toISOString(), games: [...games.values()], ratings, model, openLedger: ledger.filter((r) => r.status === "open"), ledgerIds: ledger.map((r) => r.id) });
  const byId = new Map(ledger.map((r) => [r.id, r]));
  for (const gr of out.graded) Object.assign(byId.get(gr.id), { status: "graded", result: gr.result, final: gr.final, gradedAt: gr.gradedAt, units: gr.units });
  // picks whose game vanished or never finished: void after 4 days (never counted)
  for (const r of ledger) if (r.status === "open" && Date.parse(r.start) < NOW - 4 * 864e5) Object.assign(r, { status: "void", note: "No verified final found." });
  ledger.push(...out.newPicks);
  // Closing-line value: once a game has started, compare each pick's number with the last pregame line.
  // Beating the close consistently is the quickest honest sign of a real edge (far faster than W/L).
  for (const r of ledger) {
    if (r.clv || Date.parse(r.start) > NOW) continue;
    const L = lines[r.gameId]; if (!L || Date.parse(L.at) < Date.parse(r.savedAt)) continue;
    let pts = null, prob = null;
    if (r.market === "spread" && L.spread != null) pts = r.line - (r.side === "home" ? L.spread : -L.spread);
    if (r.market === "total" && L.total != null) pts = r.side === "over" ? L.total - r.line : r.line - L.total;
    if (r.market === "moneyline" && L.mlHome != null && L.mlAway != null) {
      const imp = [L.mlHome, L.mlAway, ...(L.mlDraw != null ? [L.mlDraw] : [])].map((m) => 1 / E.toDec(m)), s = imp.reduce((a, b) => a + b, 0);
      const close = (r.side === "home" ? imp[0] : r.side === "away" ? imp[1] : imp[2] ?? NaN) / s;
      if (isFinite(close)) prob = close - r.pMkt;
    }
    if (pts != null || prob != null) r.clv = { pts, prob, closedAt: L.at };
  }
  const runs = readJson("runs.json", []);
  const archived = Object.fromEntries(Object.entries(archive).filter(([, A]) => A.length).map(([sp, A]) => [sp, A.length]));
  out.model.archive = archived; out.model.lastSummary.archive = archived;
  out.log[0] = out.log[0].replace(/\d+ new finals learned/, `${newFinals} new finals archived`);
  const log = [...out.log, `Ratings rebuilt from ${Object.values(archived).reduce((x, y) => x + y, 0)} verified finals (${Object.entries(archived).map(([k, v]) => `${k} ${v}`).join(", ")}).`, `${requests} ESPN requests${failed ? `, ${failed} failed` : ""}.`];
  runs.unshift({ at: now.toISOString(), summary: out.model.lastSummary, log, failures: failures.slice(0, 5) }); runs.length = Math.min(runs.length, 60);
  for (const s of out.touched) writeJson(`ratings/${s}.json`, out.ratings[s]);
  for (const [sp, A] of Object.entries(archive)) if (A.length) writeJson(`state/archive/${sp}.json`, A.filter((x) => Date.parse(x.d) > NOW - 800 * 864e5));
  writeJson("state/history.json", history); writeJson("debug/odds-samples.json", oddsSamples);
  writeJson("state/model.json", out.model); writeJson("state/fetched.json", fetched); writeJson("ledger.json", ledger); writeJson("runs.json", runs);
  writeJson("app.json", { at: now.toISOString(), slate: { at: now.toISOString(), games: out.slate }, model: out.model,
    ledger: [...ledger].sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || "")).slice(0, 800), runs: runs.slice(0, 15) });
  console.log(log.join("\n")); if (failures.length) console.log("Failures:\n" + failures.slice(0, 10).join("\n"));
  if (requests && failed === requests) process.exit(1); // every request failed: mark the run red
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
