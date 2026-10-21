// EdgeBot hourly update (runs in GitHub Actions; no API keys, no Claude).
// Reads ESPN's public scoreboards, learns from finals, saves/grades picks, writes data/*.json for the app.
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const E = require(path.join(ROOT, "engine.js"));
import * as PL from "./players.mjs";
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
/* ---------- the crowd: prediction-market money (Polymarket, Kalshi — public APIs) ---------- */
const PM_SERIES = { NBA: 10345, NFL: 12185, NHL: 10346, NCAAF: 12756, EPL: 10188, MLB: 3 };
const KALSHI_SERIES = { NBA: "KXNBAGAME", NFL: "KXNFLGAME", NHL: "KXNHLGAME", NCAAF: "KXNCAAFGAME", EPL: "KXEPLGAME", MLB: "KXMLBGAME" };
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** Does a crowd-market team label ("Magic", "Golden State", "Man City") name this ESPN team? */
function sameTeam(label, t) {
  const L = norm(label); if (!L) return false;
  const names = [t.name, t.short, t.abbr].map(norm).filter(Boolean);
  return names.some((n) => n === L || n.startsWith(L + " ") || n.endsWith(" " + L) || (L.length >= 4 && n.includes(L)) || (n.length >= 4 && L.includes(n)));
}
async function polymarket(sport) {
  const out = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const ev = await getJson(`https://gamma-api.polymarket.com/events?series_id=${PM_SERIES[sport]}&closed=false&limit=100&offset=${offset}&order=startDate&ascending=true`);
    if (!Array.isArray(ev) || !ev.length) break;
    for (const e of ev) {
      const mk = (e.markets || []).filter((m) => m.active !== false && !m.closed);
      const ml = mk.find((m) => m.sportsMarketType === "moneyline") || (mk.length === 1 ? mk[0] : null); if (!ml) continue;
      const parse = (x) => { try { return JSON.parse(x); } catch { return null; } };
      const outs = parse(ml.outcomes), px = (parse(ml.outcomePrices) || []).map(Number); if (!outs || outs.length < 2) continue;
      const full = (m) => !/1h|2h|half|quarter|q[1-4]|period|inning|team total|first|1st/i.test(`${m.question} ${m.groupItemTitle || ""} ${m.slug || ""}`);
      const sps = mk.filter((m) => m.sportsMarketType === "spreads" && full(m)), tots = mk.filter((m) => m.sportsMarketType === "totals" && full(m));
      out.push({ start: e.startTime || ml.gameStartTime?.replace(" ", "T").replace("+00", "Z") || e.endDate, title: e.title, slug: e.slug, vol: +e.volume || 0, vol24: +e.volume24hr || 0,
        outcomes: outs, prices: px, mlVol: +ml.volumeNum || 0,
        spreads: sps.map((sp) => ({ q: sp.question, line: +sp.line, outcomes: parse(sp.outcomes), prices: (parse(sp.outcomePrices) || []).map(Number), vol: +sp.volumeNum || 0 })),
        totals: tots.map((tot) => ({ line: +tot.line, over: +(parse(tot.outcomePrices) || [])[0], vol: +tot.volumeNum || 0 })) });
    }
    if (ev.length < 100) break;
  }
  return out;
}
async function kalshi(sport) {
  const byEvent = new Map(); let cursor = "";
  for (let page = 0; page < 3; page++) {
    const d = await getJson(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${KALSHI_SERIES[sport]}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const m of d?.markets || []) {
      const e = byEvent.get(m.event_ticker) || { ticker: m.event_ticker, sides: [] };
      e.sides.push({ team: m.yes_sub_title, last: +m.last_price_dollars || null, bid: +m.yes_bid_dollars || null, ask: +m.yes_ask_dollars || null, prev: +m.previous_price_dollars || null, vol: +m.volume_fp || 0, vol24: +m.volume_24h_fp || 0, oi: +m.open_interest_fp || 0, when: m.occurrence_datetime || m.expected_expiration_time });
      byEvent.set(m.event_ticker, e);
    }
    cursor = d?.cursor; if (!cursor || !(d?.markets || []).length) break;
  }
  return [...byEvent.values()];
}
const mid = (s) => s.bid && s.ask ? (s.bid + s.ask) / 2 : s.last;
/** Attach crowd-money data to ESPN games (matched by teams and kickoff within 3 hours / same date). */
function attachCrowd(gameList, pm, ks) {
  for (const g of gameList) {
    if (g.status === "post") continue;
    const t0 = Date.parse(g.start), crowd = {};
    const e = pm.find((x) => Math.abs(Date.parse(x.start) - t0) < 3 * 3600e3 && x.outcomes.some((o) => sameTeam(o, g.home)) && x.outcomes.some((o) => sameTeam(o, g.away)));
    if (e) {
      const hi = e.outcomes.findIndex((o) => sameTeam(o, g.home)), ai = e.outcomes.findIndex((o) => sameTeam(o, g.away)), di = e.outcomes.findIndex((o) => /draw|tie/i.test(o));
      // full-game spread/total closest to the sportsbook line (Polymarket also lists halves and alternate lines)
      const closest = (arr, target, key) => arr.filter((x) => isFinite(x[key])).sort((a, b) => (target != null ? Math.abs(Math.abs(a[key]) - Math.abs(target)) - Math.abs(Math.abs(b[key]) - Math.abs(target)) : 0) || b.vol - a.vol)[0];
      const sp = closest(e.spreads.filter((x) => x.outcomes), g.spread, "line"), tot = closest(e.totals, g.total, "line");
      const spOk = sp && (g.spread == null || Math.abs(Math.abs(sp.line) - Math.abs(g.spread)) <= 3), totOk = tot && isFinite(tot.over) && (g.total == null || Math.abs(tot.line - g.total) <= Math.max(3, 0.08 * g.total));
      crowd.pm = { home: e.prices[hi], away: e.prices[ai], draw: di >= 0 ? e.prices[di] : null, vol: Math.round(e.vol), vol24: Math.round(e.vol24), mlVol: Math.round(e.mlVol), slug: e.slug,
        spread: spOk ? { label: `${sp.outcomes[0]} ${sp.line > 0 ? "+" : ""}${sp.line}`, line: sp.line, fav: sp.outcomes[0], favP: sp.prices[0], vol: Math.round(sp.vol) } : null,
        total: totOk ? { line: tot.line, over: tot.over, vol: Math.round(tot.vol) } : null };
    }
    const day = etDate(t0), k = ks.find((x) => x.sides.some((s) => sameTeam(s.team, g.home)) && x.sides.some((s) => sameTeam(s.team, g.away)) && x.sides.some((s) => s.when && Math.abs(Date.parse(s.when) - t0) < 36 * 3600e3));
    if (k) {
      const h = k.sides.find((s) => sameTeam(s.team, g.home)), a = k.sides.find((s) => sameTeam(s.team, g.away)), d = k.sides.find((s) => /tie|draw/i.test(s.team || ""));
      crowd.k = { home: mid(h), away: mid(a), draw: d ? mid(d) : null, homePrev: h.prev, awayPrev: a.prev, vol: Math.round(k.sides.reduce((x, s) => x + s.vol, 0)), vol24: Math.round(k.sides.reduce((x, s) => x + s.vol24, 0)), oi: Math.round(k.sides.reduce((x, s) => x + s.oi, 0)), ticker: k.ticker };
    }
    void day;
    if (!crowd.pm && !crowd.k) continue;
    // one crowd number: money-weighted, normalised home-win probability
    const srcs = [];
    if (crowd.pm && crowd.pm.home > 0 && crowd.pm.away > 0) srcs.push({ p: crowd.pm.home / (crowd.pm.home + crowd.pm.away + (crowd.pm.draw || 0)), d: crowd.pm.draw ? crowd.pm.draw / (crowd.pm.home + crowd.pm.away + crowd.pm.draw) : 0, w: Math.max(1, crowd.pm.mlVol || crowd.pm.vol) });
    if (crowd.k && crowd.k.home > 0 && crowd.k.away > 0) srcs.push({ p: crowd.k.home / (crowd.k.home + crowd.k.away + (crowd.k.draw || 0)), d: crowd.k.draw ? crowd.k.draw / (crowd.k.home + crowd.k.away + crowd.k.draw) : 0, w: Math.max(1, crowd.k.vol) });
    const W = srcs.reduce((x, s) => x + s.w, 0);
    if (W) { crowd.pHome = srcs.reduce((x, s) => x + s.p * s.w, 0) / W; crowd.pDraw = srcs.reduce((x, s) => x + s.d * s.w, 0) / W; }
    crowd.money = (crowd.pm?.vol || 0) + (crowd.k?.vol || 0); crowd.money24 = (crowd.pm?.vol24 || 0) + (crowd.k?.vol24 || 0);
    if (crowd.k?.homePrev && crowd.k.home) crowd.move24 = crowd.k.home - crowd.k.homePrev;
    g.crowd = crowd;
  }
}
/** ESPN game summary: ESPN's own matchup predictor and each team's record against the spread. */
async function espnExtras(g) {
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[g.sport]}/summary?event=${g.id.split(":")[1]}`); if (!d) return;
  const pr = d.predictor; if (pr?.homeTeam && pr?.awayTeam) { const h = num(pr.homeTeam.gameProjection), a = num(pr.awayTeam.gameProjection); if (h != null && a != null) g.espnPredictor = { home: h / 100, away: a / 100 }; }
  const ats = {}; for (const t of d.againstTheSpread || []) { const ab = t.team?.abbreviation, rec = (t.records || [])[0]?.summary; if (ab && rec) ats[ab === g.home.abbr ? "home" : ab === g.away.abbr ? "away" : ab] = rec; }
  if (ats.home || ats.away) g.ats = ats;
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
  const rec = (t) => (t.records || []).find((r) => r.type === "total" || r.name === "overall" || r.name === "All Splits")?.summary || t.records?.[0]?.summary || null;
  const team = (t) => ({ abbr: t.team.abbreviation || t.team.shortDisplayName, name: t.team.displayName || t.team.name, short: t.team.shortDisplayName || t.team.name || null,
    logo: t.team.logo || t.team.logos?.[0]?.href || null, color: t.team.color || null, alt: t.team.alternateColor || null, record: rec(t), score: status === "pre" ? null : num(t.score) });
  const g = { id: `${sport}:${ev.id}`, sport, start: new Date(ev.date).toISOString(), status, home: team(home), away: team(away),
    venue: c.venue?.fullName || null, tv: (c.broadcasts || []).flatMap((b) => b.names || []).slice(0, 2).join(", ") || null,
    detail: ev.status?.type?.shortDetail || null, rank: { home: home.curatedRank?.current < 99 ? home.curatedRank.current : null, away: away.curatedRank?.current < 99 ? away.curatedRank.current : null },
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
      nflMeta.set(id, { rest, stadium: r.stadium_id, roof: r.roof, neutral: r.location === "Neutral", nvId: r.game_id, season: +r.season, week: +r.week });
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
  // line history: every distinct pregame line EdgeBot has seen (opening → now), for movement and charts
  const lineHist = readJson("state/linehist.json", {});
  for (const g of games.values()) {
    if (g.status !== "pre" || (g.spread == null && g.mlHome == null && g.total == null)) continue;
    const H = (lineHist[g.id] ||= { start: g.start, pts: [] }), last = H.pts[H.pts.length - 1], pt = { t: now.toISOString(), sp: g.spread, tot: g.total, mh: g.mlHome, ma: g.mlAway };
    if (!last || last.sp !== pt.sp || last.tot !== pt.tot || last.mh !== pt.mh || last.ma !== pt.ma) H.pts.push(pt);
    if (H.pts.length > 40) H.pts.splice(1, H.pts.length - 40);
  }
  for (const [id, H] of Object.entries(lineHist)) if (Date.parse(H.start) < NOW - 3 * 864e5) delete lineHist[id];
  writeJson("state/linehist.json", lineHist);
  for (const g of games.values()) if (lineHist[g.id] && g.status !== "post") g.lineHist = lineHist[g.id].pts;
  // team directory (logo, colours, names) so every screen can show proper marks
  const teams = readJson("state/teams.json", {});
  for (const g of games.values()) for (const t of [g.home, g.away]) if (t.logo || t.color) teams[`${g.sport}|${t.abbr}`] = { name: t.name, short: t.short, logo: t.logo, color: t.color, alt: t.alt, record: t.record ?? teams[`${g.sport}|${t.abbr}`]?.record ?? null };
  writeJson("state/teams.json", teams);
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
  // the crowd (prediction markets) + ESPN extras for games in the next ~36 hours
  const upcoming = [...games.values()].filter((g) => g.status !== "post" && Date.parse(g.start) < NOW + 7 * 864e5);
  const sportsNow = [...new Set(upcoming.map((g) => g.sport))];
  const pmAll = [], kAll = [];
  for (const sp of sportsNow) { const [pm, k] = await Promise.all([polymarket(sp), kalshi(sp)]); pmAll.push(...pm); kAll.push(...k); attachCrowd(upcoming.filter((g) => g.sport === sp), pm, k); }
  const soon = upcoming.filter((g) => g.status === "pre" && Date.parse(g.start) < NOW + 36 * 3600e3);
  for (let i = 0; i < soon.length; i += 6) await Promise.all(soon.slice(i, i + 6).map(espnExtras));
  // rebuild ratings from the archive (last season regressed 30% toward average, then this season)
  // self-tuning, once a day: pick the settings that predicted this archive's finals best (walk-forward)
  const prevModel = readJson("state/model.json", {}), tuned = prevModel.tuned || {};
  for (const sp of Object.keys(E.SPORTS)) {
    if (archive[sp].length < 250 || (tuned[sp] && NOW - Date.parse(tuned[sp].tunedAt) < 20 * 3600e3 && tuned[sp].games)) continue;
    const t = E.tune(sp, archive[sp], now.toISOString()); if (t) tuned[sp] = t;
  }
  const ratings = {};
  for (const sp of Object.keys(E.SPORTS)) if (archive[sp].length) ratings[sp] = E.buildRatings(sp, archive[sp], SEASON_START[sp], now.toISOString(), tuned[sp]?.params);
  const model = readJson("state/model.json", {}), ledger = readJson("ledger.json", []);
  model.clvLanes = {};
  for (const r of ledger) if (r.clv && r.status !== "void") { const k = `${r.sport}|${r.market}`, c = (model.clvLanes[k] ||= { n: 0, beat: 0 }); c.n++; if ((r.clv.pts ?? 0) > 0 || (r.clv.prob ?? 0) > 0.002) c.beat++; }
  const out = E.runCycle({ now: now.toISOString(), games: [...games.values()], ratings, model, openLedger: ledger.filter((r) => r.status === "open"), ledgerIds: ledger.map((r) => r.id) });
  const byId = new Map(ledger.map((r) => [r.id, r]));
  for (const gr of out.graded) Object.assign(byId.get(gr.id), { status: "graded", result: gr.result, final: gr.final, gradedAt: gr.gradedAt, units: gr.units });
  // v2.3 fix: puck/run-line picks saved before real prices were read assumed -110 — void them (never counted)
  for (const r of ledger) if (r.status === "open" && (r.sport === "NHL" || r.sport === "MLB") && r.market === "spread" && r.price === -110 && !/^edgebot-v2\.[3-9]/.test(r.model || ""))
    Object.assign(r, { status: "void", note: "Voided: saved before EdgeBot read real puck-line prices (assumed -110)." });
  // one tracked pick per game: keep the first saved, void later duplicates (never counted)
  const firstForGame = new Map();
  for (const r of [...ledger].sort((x, y) => (x.savedAt || "").localeCompare(y.savedAt || ""))) {
    if (r.status === "void") continue;
    if (!firstForGame.has(r.gameId)) firstForGame.set(r.gameId, r.id);
    else if (r.status === "open") Object.assign(r, { status: "void", note: "Voided: a pick on this game was already saved earlier." });
  }
  // picks whose game vanished or never finished: void after 4 days (never counted)
  for (const r of ledger) if (r.status === "open" && Date.parse(r.start) < NOW - 4 * 864e5) Object.assign(r, { status: "void", note: "No verified final found." });
  for (const r of out.newPicks) { const g = games.get(r.gameId); if (!g) continue;
    const side = r.side === "home" ? "home" : r.side === "away" ? "away" : null;
    if (g.crowd?.pHome != null && side) r.crowdP = +(side === "home" ? g.crowd.pHome : 1 - g.crowd.pHome - (g.crowd.pDraw || 0)).toFixed(4);
    if (g.espnPredictor && side) r.espnP = g.espnPredictor[side]; }
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
  out.model.tuned = tuned;
  const players = await playersCycle({ games, archive, ratings, injuryBooks, nflMeta });
  out.model.power = Object.fromEntries(Object.entries(ratings).map(([sp, R]) => [sp, Object.entries(R.teams).filter(([, t]) => t.n >= 3)
    .map(([abbr, t]) => ({ abbr, r: +t.r.toFixed(2), o: +t.o.toFixed(2), d: +t.d.toFixed(2), n: t.n })).sort((a, b) => b.r - a.r).slice(0, sp === "NCAAF" ? 60 : 40)]));
  const teamsOut = {}; for (const sp of Object.keys(out.model.power)) for (const t of out.model.power[sp]) if (teams[`${sp}|${t.abbr}`]) teamsOut[`${sp}|${t.abbr}`] = teams[`${sp}|${t.abbr}`];
  for (const r of ledger.slice(-800)) for (const a of [r.home, r.away]) if (a && teams[`${r.sport}|${a}`]) teamsOut[`${r.sport}|${a}`] = teams[`${r.sport}|${a}`];
  writeJson("app.json", { at: now.toISOString(), players, teams: teamsOut, slate: { at: now.toISOString(), games: out.slate }, model: out.model,
    ledger: [...ledger].sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || "")).slice(0, 800), runs: runs.slice(0, 15) });
  console.log(log.join("\n")); if (failures.length) console.log("Failures:\n" + failures.slice(0, 10).join("\n"));
  if (requests && failed === requests) process.exit(1); // every request failed: mark the run red
}
/* ------------------------------ players ------------------------------ */
async function playersCycle({ games, archive, ratings, injuryBooks, nflMeta }) {
  const t0 = Date.now(), log = [];
  // 1) NBA box-score archive (this season first, then last season, newest first; capped per run)
  const box = readJson("state/players/NBA.json", []), done = new Set(readJson("state/players/NBA-done.json", []));
  const todo = [...(archive.NBA || [])].filter((x) => !done.has(x.id)).sort((a, b) => (a.d >= SEASON_START.NBA) - (b.d >= SEASON_START.NBA) || (a.d < b.d ? 1 : -1))
    .sort((a, b) => (b.d >= SEASON_START.NBA) - (a.d >= SEASON_START.NBA)).slice(0, 160);
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(async (x) => {
    const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${x.id.split(":")[1]}`);
    if (!d?.boxscore) return; box.push(...PL.parseNbaBox(d, x.id, x.d)); done.add(x.id);
  }));
  for (const r of box) r.cur = r.d >= SEASON_START.NBA ? 1 : 0;
  writeJson("state/players/NBA.json", box); writeJson("state/players/NBA-done.json", [...done]);
  log.push(`${done.size} NBA box scores archived (+${todo.length} this run).`);
  // 2) NFL weekly player stats (nflverse) + ESPN↔nflverse player ids
  let nfl = [], nflIdByEspn = new Map();
  const [c25, c26, pl] = await Promise.all([
    getText("https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv"),
    getText("https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv"),
    getText("https://github.com/nflverse/nflverse-data/releases/download/players/players.csv")]);
  if (c25 || c26) { nfl = PL.nflRowsFromCsv([...(c25 ? parseCsv(c25) : []), ...(c26 ? parseCsv(c26) : [])]); for (const r of nfl) r.cur = r.season >= 2026 ? 1 : 0; }
  if (pl) for (const r of parseCsv(pl)) if (r.espn_id && r.gsis_id) nflIdByEspn.set(String(r.espn_id).replace(/\.0$/, ""), r.gsis_id);
  log.push(`${nfl.length} NFL player-weeks loaded; ${nflIdByEspn.size} player ids mapped.`);
  // history per player, oldest → newest
  const hist = { NBA: new Map(), NFL: new Map() };
  for (const r of [...box].sort((a, b) => (a.d < b.d ? -1 : 1))) { const L = hist.NBA.get(r.id) || []; L.push(r); hist.NBA.set(r.id, L); }
  for (const r of [...nfl].sort((a, b) => a.season - b.season || a.week - b.week)) { const L = hist.NFL.get(r.id) || []; L.push(r); hist.NFL.set(r.id, L); }
  // 3) prop lines for upcoming games → projections → picks
  // v2 player picks only (the first run used unbalanced lines and too little history — never counted)
  const ledger = readJson("playerLedger.json", []).filter((r) => r.mv === 3), have = new Set(ledger.map((r) => r.id)), props = [], unmatched = new Set();
  const laneStats = new Map(); for (const r of ledger) if (r.status === "graded" && r.result !== "P") { const k = `${r.sport}|${r.stat}`, c = laneStats.get(k) || { n: 0, w: 0 }; c.n++; if (r.result === "W") c.w++; laneStats.set(k, c); }
  const upcoming = [...games.values()].filter((g) => g.status === "pre" && ((g.sport === "NBA" && Date.parse(g.start) < NOW + 36 * 3600e3) || (g.sport === "NFL" && Date.parse(g.start) < NOW + 5 * 864e5)) && Date.parse(g.start) > NOW);
  const R = ratings.NBA, half = R ? R.lg.avgT / 2 : 114;
  for (let i = 0; i < upcoming.length; i += 4) await Promise.all(upcoming.slice(i, i + 4).map(async (g) => {
    const { lines, unmatched: um } = await PL.propLines(getJson, g.sport, PATHS[g.sport], g.id.split(":")[1]); um.forEach((u) => unmatched.add(`${g.sport}: ${u}`));
    const inj = injuryBooks[g.sport] || {}, injured = new Map([...(inj[g.home.name] || []), ...(inj[g.away.name] || [])].map((p) => [p.name, p.status]));
    for (const L of lines) {
      const pid = g.sport === "NFL" ? nflIdByEspn.get(L.pid) : L.pid, H = pid ? hist[g.sport].get(pid) : null; if (!H || !H.length) continue;
      const lastRow = H[H.length - 1], team = lastRow.t, side = team === g.home.abbr ? "home" : team === g.away.abbr ? "away" : null; if (!side) continue;
      const opp = side === "home" ? g.away.abbr : g.home.abbr, status = injured.get(lastRow.n);
      if (status === "OUT" || status === "DOUBTFUL") continue;
      const oppT = g.sport === "NBA" && R ? R.teams[opp] : null, oppFactor = oppT ? 1 + oppT.d / half : 1;
      const own = PL.project(g.sport, H, L.stat, { oppFactor }); if (!own) continue;
      // sanity: if EdgeBot's own number is miles from the line, the line knows something (role, injury) — no pick
      const wild = Math.abs(own.mean - L.line) > 1.6 * own.sd;
      const proj = PL.blendWithLine(own, L.line);
      const pH = PL.pHigher(proj, L.line), pickSide = pH >= 0.5 ? "higher" : "lower", p = Math.max(pH, 1 - pH);
      const lane = laneStats.get(`${g.sport}|${L.stat}`), proven = lane && lane.n >= 30 && lane.w / lane.n >= 0.56;
      const tier = wild ? null : PL.propTier(p, proven);
      const row = { id: `${g.id}~${pid}~${L.stat}`, gameId: g.id, sport: g.sport, start: g.start, pid, espnId: L.pid, name: lastRow.n, pos: lastRow.pos, team, opp, home: side === "home",
        head: g.sport === "NBA" ? `https://a.espncdn.com/i/headshots/nba/players/full/${L.pid}.png` : lastRow.head || `https://a.espncdn.com/i/headshots/nfl/players/full/${L.pid}.png`,
        stat: L.stat, label: PL.STAT_LABEL[L.stat] || L.stat, line: L.line, proj: +proj.mean.toFixed(2), own: +own.mean.toFixed(2), wild, mv: 3, sd: +proj.sd.toFixed(2), pHigher: +pH.toFixed(4), side: pickSide, p: +p.toFixed(4), tier,
        games: proj.n, gamesThisSeason: proj.nCur, minutes: proj.min ? +proj.min.toFixed(1) : null, last: proj.last, status: status || null, oppFactor: +oppFactor.toFixed(3) };
      props.push(row);
      if (tier && !have.has(row.id) && (!status || status === "DAY_TO_DAY")) { ledger.push({ ...row, status: "open", savedAt: now.toISOString() }); have.add(row.id); }
    }
  }));
  // 4) grade player picks from box scores / nflverse once the game is final
  const nbaByGame = new Map(); for (const r of box) { const k = `${r.g}|${r.id}`; nbaByGame.set(k, r); }
  const nflByKey = new Map(); for (const r of nfl) nflByKey.set(`${r.g}|${r.id}`, r);
  let graded = 0;
  for (const r of ledger) {
    if (r.status !== "open") continue;
    const g = games.get(r.gameId);
    let row = null;
    if (r.sport === "NBA") row = nbaByGame.get(`${r.gameId}|${r.pid}`);
    else { const m = nflMeta.get(r.gameId); if (m) row = nflByKey.get(`${m.nvId}|${r.pid}`); }
    if (row) { const res = PL.gradeProp(r, row); if (res) { Object.assign(r, { status: "graded", result: res, actual: PL.valueOf(row, r.stat), gradedAt: now.toISOString() }); graded++; } }
    else if ((g && g.status === "post" && Date.parse(r.start) < NOW - 36 * 3600e3) || Date.parse(r.start) < NOW - 9 * 864e5) Object.assign(r, { status: "void", note: "Player didn’t record stats (DNP) or no box score." });
  }
  writeJson("playerLedger.json", ledger);
  writeJson("debug/prop-types-unmatched.json", [...unmatched]);
  const G = ledger.filter((r) => r.status === "graded"), W = G.filter((r) => r.result === "W").length, Lx = G.filter((r) => r.result === "L").length;
  log.push(`${props.length} player lines projected, ${ledger.filter((r) => r.status === "open").length} open player picks, ${graded} graded this run (${Date.now() - t0} ms).`);
  console.log(log.join("\n"));
  writeProfiles({ hist, props, ledger, games, archive, ratings, injuryBooks });
  return { at: now.toISOString(), props: props.sort((a, b) => b.p - a.p).slice(0, 700), ledger: ledger.slice(-500), record: { w: W, l: Lx, p: G.length - W - Lx }, log };
}

/* ------------------------------ profiles (search, player & team pages; loaded on demand) ------------------------------ */
const PSTATS = { NBA: ["min", "pts", "reb", "ast", "tpm", "stl", "blk"], NFL: ["passYds", "passTd", "int", "rushYds", "rushAtt", "rec", "recYds"] };
function writeProfiles({ hist, props, ledger, games, archive, ratings, injuryBooks }) {
  const teamsDir = readJson("state/teams.json", {}), propIds = new Set(props.map((x) => `${x.sport}|${x.pid}`));
  const r1 = (v) => Math.round(v * 10) / 10;
  const avg = (rows, keys) => rows.length ? Object.fromEntries(keys.map((k) => [k, r1(rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length)])) : null;
  const players = [];
  for (const sp of ["NBA", "NFL"]) for (const [pid, H] of hist[sp]) {
    const cur = H.filter((r) => r.cur), prev = H.filter((r) => !r.cur), last = H[H.length - 1];
    if (!cur.length && !propIds.has(`${sp}|${pid}`) && (sp === "NFL" || prev.length < 20)) continue;
    const keys = PSTATS[sp], rel = sp === "NFL" ? keys.filter((k) => H.some((r) => r[k])) : keys;
    if (sp === "NFL" && !rel.some((k) => ["passYds", "rushYds", "recYds"].includes(k))) continue;
    players.push({ id: pid, sport: sp, name: last.n, team: last.t, pos: last.pos || "",
      head: sp === "NBA" ? `https://a.espncdn.com/i/headshots/nba/players/full/${pid}.png` : last.head || null,
      cur: cur.length ? { gp: cur.length, avg: avg(cur, rel) } : null, prev: prev.length ? { gp: prev.length, avg: avg(prev, rel) } : null,
      log: H.slice(-10).reverse().map((r) => ({ d: r.d, opp: r.o, ...Object.fromEntries(rel.map((k) => [k, r[k] ?? 0])) })), keys: rel });
  }
  // teams: record, results, scoring, power, leaders, injuries, upcoming
  const teams = [];
  for (const [sp, A] of Object.entries(archive)) {
    if (!A.length) continue;
    const R = ratings[sp], order = R ? Object.entries(R.teams).filter(([, t]) => t.n >= 3).sort((a, b) => b[1].r - a[1].r).map(([k]) => k) : [];
    const by = new Map();
    for (const x of [...A].sort((a, b) => (a.d < b.d ? -1 : 1))) for (const [us, them, sUs, sThem, home] of [[x.h, x.a, x.hs, x.as, true], [x.a, x.h, x.as, x.hs, false]]) {
      const L = by.get(us) || []; L.push({ d: x.d, opp: them, home, us: sUs, them: sThem, cur: x.d >= SEASON_START[sp] }); by.set(us, L);
    }
    const inj = injuryBooks[sp] || {};
    for (const [abbr, L] of by) {
      const dir = teamsDir[`${sp}|${abbr}`]; const cur = L.filter((x) => x.cur);
      if (!dir && !cur.length) continue;
      const res = (x) => x.us > x.them ? "W" : x.us < x.them ? "L" : "T";
      const w = cur.filter((x) => res(x) === "W").length, l = cur.filter((x) => res(x) === "L").length, t = cur.length - w - l;
      let streak = ""; for (let i = L.length - 1; i >= 0; i--) { const r = res(L[i]); if (!streak) streak = r; else if (streak[0] !== r) break; else streak += r; }
      const T = R?.teams[abbr];
      let leaders = [];
      if (sp === "NBA" || sp === "NFL") {
        const roster = players.filter((p) => p.sport === sp && p.team === abbr);
        if (sp === "NBA") leaders = roster.map((p) => ({ id: p.id, name: p.name, v: (p.cur || p.prev)?.avg?.pts ?? 0, k: "ppg" })).sort((a, b) => b.v - a.v).slice(0, 5);
        else for (const [k, lab] of [["passYds", "pass yds/g"], ["rushYds", "rush yds/g"], ["recYds", "rec yds/g"]]) { const b = roster.map((p) => ({ id: p.id, name: p.name, v: (p.cur || p.prev)?.avg?.[k] ?? 0, k: lab })).sort((a, b) => b.v - a.v)[0]; if (b && b.v > 0) leaders.push(b); }
      }
      const upcoming = [...games.values()].filter((g) => g.sport === sp && g.status !== "post" && (g.home.abbr === abbr || g.away.abbr === abbr)).sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, 3).map((g) => g.id);
      const name = dir?.name || abbr;
      teams.push({ sport: sp, abbr, name, short: dir?.short || name, logo: dir?.logo || null, color: dir?.color || null, alt: dir?.alt || null, record: dir?.record || `${w}-${l}${t ? "-" + t : ""}`,
        w, l, t, streak: streak ? `${streak[0]}${streak.length}` : "", pf: cur.length ? r1(cur.reduce((s, x) => s + x.us, 0) / cur.length) : null, pa: cur.length ? r1(cur.reduce((s, x) => s + x.them, 0) / cur.length) : null,
        rating: T ? r1(T.r) : null, rank: order.indexOf(abbr) >= 0 ? order.indexOf(abbr) + 1 : null, of: order.length,
        last: L.slice(-10).reverse().map((x) => ({ d: x.d, opp: x.opp, home: x.home, us: x.us, them: x.them, r: res(x) })), leaders, upcoming, injuries: inj[name] || [] });
    }
  }
  writeJson("profiles.json", { at: now.toISOString(), players, teams });
  console.log(`profiles: ${players.length} players, ${teams.length} teams`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
