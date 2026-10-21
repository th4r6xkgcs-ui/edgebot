// EdgeBot players: box-score archive → per-player projections → Higher/Lower picks vs sportsbook prop lines.
// Lines: DraftKings player props via ESPN's public odds API. Underdog's own lines aren't published through a
// permitted source; they usually sit within ~0.5 of these, so every pick says to check the line in the app.
// Picks are saved before tip-off and graded from the box score, like team picks.

const NBA_PROP = {
  "Total Points": "pts", "Total Rebounds": "reb", "Total Assists": "ast", "Total 3-Point Field Goals": "tpm",
  "Total Steals": "stl", "Total Blocks": "blk", "Total Points and Assists": "pa", "Total Points and Rebounds": "pr",
  "Total Assists and Rebounds": "ar", "Total Points, Rebounds, and Assists": "pra", "Total Steals and Blocks": "sb",
};
export const STAT_LABEL = { pts: "Points", reb: "Rebounds", ast: "Assists", tpm: "3-Pointers", stl: "Steals", blk: "Blocks", pa: "Pts + Ast", pr: "Pts + Reb", ar: "Reb + Ast", pra: "Pts + Reb + Ast", sb: "Stl + Blk",
  passYds: "Pass Yards", passTd: "Pass TDs", passAtt: "Pass Attempts", passCmp: "Completions", int: "Interceptions", rushYds: "Rush Yards", rushAtt: "Rush Attempts", rec: "Receptions", recYds: "Rec Yards", rushRecYds: "Rush + Rec Yards" };
const NFL_PROP = [ // keyword → stat (ESPN type names vary; matched loosely)
  [/passing yards/i, "passYds"], [/passing touchdowns|pass(ing)? tds?/i, "passTd"], [/pass(ing)? attempts/i, "passAtt"], [/completions/i, "passCmp"], [/interceptions/i, "int"],
  [/rushing and receiving yards|rush(ing)? \+ rec/i, "rushRecYds"], [/rushing yards/i, "rushYds"], [/rush(ing)? attempts|carries/i, "rushAtt"], [/receiving yards/i, "recYds"], [/receptions/i, "rec"],
];
const COMBO = { pa: ["pts", "ast"], pr: ["pts", "reb"], ar: ["ast", "reb"], pra: ["pts", "reb", "ast"], sb: ["stl", "blk"], rushRecYds: ["rushYds", "recYds"] };
const COUNTY = new Set(["tpm", "stl", "blk", "sb", "passTd", "int", "rec"]); // low counts: Poisson-like spread
const valueOf = (row, stat) => COMBO[stat] ? COMBO[stat].reduce((s, k) => s + (row[k] ?? 0), 0) : row[stat];

function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const ncdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/* ------------------------------ NBA box scores ------------------------------ */
export function parseNbaBox(summary, gameId, date) {
  const rows = [];
  for (const side of summary?.boxscore?.players || []) {
    const team = side.team?.abbreviation, st = side.statistics?.[0]; if (!team || !st) continue;
    const idx = Object.fromEntries((st.keys || []).map((k, i) => [k, i]));
    const opp = (summary.boxscore.players.find((x) => x.team?.abbreviation !== team) || {}).team?.abbreviation;
    for (const a of st.athletes || []) {
      if (a.didNotPlay || !a.stats?.length) continue;
      const g = (k) => a.stats[idx[k]], n = (k) => { const v = parseFloat(g(k)); return isFinite(v) ? v : 0; };
      const min = n("minutes"); if (min <= 0) continue;
      const tp = String(g("threePointFieldGoalsMade-threePointFieldGoalsAttempted") || "0-0").split("-")[0];
      rows.push({ g: gameId, d: date, t: team, o: opp, id: a.athlete?.id, n: a.athlete?.displayName, pos: a.athlete?.position?.abbreviation || "", st: a.starter ? 1 : 0,
        min, pts: n("points"), reb: n("rebounds"), ast: n("assists"), tpm: +tp || 0, stl: n("steals"), blk: n("blocks"), tov: n("turnovers") });
    }
  }
  return rows;
}

/* ------------------------------ NFL weekly stats (nflverse) ------------------------------ */
export function nflRowsFromCsv(rows) {
  const out = [];
  for (const r of rows) {
    if (r.season_type && r.season_type !== "REG" && r.season_type !== "POST") continue;
    const f = (k) => { const v = parseFloat(r[k]); return isFinite(v) ? v : 0; };
    out.push({ g: r.game_id || `${r.season}-${r.week}-${r.team || r.recent_team}`, d: `${r.season}-W${String(r.week).padStart(2, "0")}`, season: +r.season, week: +r.week,
      t: r.team || r.recent_team, o: r.opponent_team, id: r.player_id, n: r.player_display_name || r.player_name, pos: r.position, head: r.headshot_url || null,
      passYds: f("passing_yards"), passTd: f("passing_tds"), passAtt: f("attempts"), passCmp: f("completions"), int: f("passing_interceptions") || f("interceptions"),
      rushYds: f("rushing_yards"), rushAtt: f("carries"), rec: f("receptions"), recYds: f("receiving_yards"), tgt: f("targets") });
  }
  return out;
}

/* ------------------------------ prop lines ------------------------------ */
export async function propLines(getJson, sport, path, eventId) {
  const league = sport === "NBA" ? "basketball/leagues/nba" : "football/leagues/nfl";
  const items = [];
  for (let page = 1; page <= 4; page++) {
    const d = await getJson(`https://sports.core.api.espn.com/v2/sports/${league}/events/${eventId}/competitions/${eventId}/odds/100/propBets?lang=en&region=us&limit=1000&page=${page}`);
    if (!d?.items?.length) break; items.push(...d.items); if (page >= (d.pageCount || 1)) break;
  }
  const by = new Map(), unmatched = new Set();
  for (const it of items) {
    const type = it.type?.name || "", pid = (it.athlete?.$ref || "").match(/athletes\/(\d+|[\w-]+)\?/)?.[1]; if (!pid) continue;
    let stat = sport === "NBA" ? NBA_PROP[type] : (NFL_PROP.find(([re]) => re.test(type)) || [])[1];
    if (!stat) { unmatched.add(type); continue; }
    if (/milestone|longest|first|1st|anytime|alt|quarter|half|2 or more|exact/i.test(type)) continue;
    const line = +(it.current?.target?.value ?? it.odds?.total?.value); if (!isFinite(line)) continue;
    const k = `${pid}|${stat}`, e = by.get(k) || { pid, stat, lines: [] };
    e.lines.push({ line, price: +(it.odds?.american?.value ?? NaN) }); by.set(k, e);
  }
  // main line = the one whose prices are most balanced (both sides near -110). Alternate lines are lopsided (-400/+250).
  const out = [];
  for (const e of by.values()) {
    const byLine = new Map(); for (const l of e.lines) { const L = byLine.get(l.line) || []; if (isFinite(l.price)) L.push(l.price); byLine.set(l.line, L); }
    const toProb = (a) => a < 0 ? -a / (-a + 100) : 100 / (a + 100);
    const scored = [...byLine.entries()].map(([line, prices]) => ({ line, n: prices.length, dev: prices.length ? Math.max(...prices.map((x) => Math.abs(toProb(x) - 0.524))) : 1 }))
      .filter((x) => x.dev < 0.14).sort((a, b) => a.dev - b.dev || b.n - a.n);
    if (!scored.length) continue;
    out.push({ pid: e.pid, stat: e.stat, line: scored[0].line, alts: byLine.size, balanced: +scored[0].dev.toFixed(3) });
  }
  return { lines: out, unmatched: [...unmatched].slice(0, 40) };
}

/* ------------------------------ projections ------------------------------ */
/** Recency-weighted projection for one player and stat. NBA projects per-minute rates × expected minutes. */
export function project(sport, history, stat, ctx = {}) {
  const rows = history.filter((r) => valueOf(r, stat) != null);
  if (rows.length < (sport === "NBA" ? 15 : 8)) return null;
  const cur = rows.filter((r) => r.cur), w = rows.map((r, i) => { const age = rows.length - 1 - i; return (r.cur ? 1 : 0.35) * Math.pow(0.5, age / (r.cur ? 8 : 12)); });
  const W = w.reduce((a, b) => a + b, 0);
  let mean, sd;
  if (sport === "NBA") {
    const minW = rows.reduce((s, r, i) => s + w[i] * r.min, 0) / W;
    const expMin = cur.length >= 2 ? (0.7 * cur.slice(-5).reduce((s, r) => s + r.min, 0) / Math.min(5, cur.length) + 0.3 * minW) : minW * 0.95;
    const rate = rows.reduce((s, r, i) => s + w[i] * valueOf(r, stat), 0) / rows.reduce((s, r, i) => s + w[i] * r.min, 0);
    mean = rate * expMin * (ctx.oppFactor && ["pts", "pa", "pr", "pra"].includes(stat) ? ctx.oppFactor : 1);
    const resid = rows.map((r, i) => [w[i], valueOf(r, stat) - rate * r.min]);
    const scaled = Math.sqrt(resid.reduce((s, [ww, e]) => s + ww * e * e, 0) / W) * Math.sqrt(Math.max(0.4, expMin / Math.max(1, minW)));
    sd = Math.max(scaled, Math.sqrt(Math.max(0.5, mean)) * (COUNTY.has(stat) ? 1.05 : 0.6));
    return { mean, sd, n: rows.length, nCur: cur.length, min: expMin, last: rows.slice(-8).map((r) => valueOf(r, stat)) };
  }
  mean = rows.reduce((s, r, i) => s + w[i] * valueOf(r, stat), 0) / W;
  sd = Math.sqrt(rows.reduce((s, r, i) => s + w[i] * (valueOf(r, stat) - mean) ** 2, 0) / W);
  sd = Math.max(sd, Math.sqrt(Math.max(0.5, mean)) * (COUNTY.has(stat) ? 1.05 : 0.8));
  return { mean, sd, n: rows.length, nCur: cur.length, last: rows.slice(-8).map((r) => valueOf(r, stat)) };
}
/** Weight on EdgeBot's own projection vs the prop line (the line already prices roles, injuries and news EdgeBot
 *  can't see). A starting value until enough graded player picks exist to learn it, like the team blend. */
export const PROP_WEIGHT = 0.4;
export function blendWithLine(proj, line, w = PROP_WEIGHT) { return { ...proj, raw: proj.mean, mean: w * proj.mean + (1 - w) * line }; }
/** P(stat > line) for a projection, with a half-unit continuity correction on whole-number stats. */
export const pHigher = (proj, line) => 1 - ncdf((line + (Number.isInteger(line) ? 0.5 : 0) - proj.mean) / proj.sd);

/** Underdog-style pick strength: entries pay a fixed multiple, so each leg needs ~55–58% to break even. */
export function propTier(p) { return p >= 0.64 ? "Strong" : p >= 0.6 ? "Value" : p >= 0.56 ? "Lean" : null; }

export function gradeProp(pick, row) {
  if (!row) return null; const v = valueOf(row, pick.stat); if (v == null) return null;
  if (v === pick.line) return "P"; return (pick.side === "higher") === (v > pick.line) ? "W" : "L";
}
export { valueOf };
