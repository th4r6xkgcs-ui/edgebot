// EdgeBot matchups: tennis, UFC and esports (head-to-head, no score margin).
// Source: Polymarket's public market data — open events give the crowd's price and money traded,
// closed events give verified winners. An Elo rating per player/team (per esports title) is replayed from
// those results and blended with the crowd's price; a pick needs a real edge over that price.

const GROUPS = {
  TENNIS: { codes: ["atp", "wta"], k: 32, label: "Tennis" },
  UFC: { codes: ["ufc", "mma"], k: 40, label: "UFC" },
  ESPORTS: { codes: ["cs2", "csgo", "lol", "val", "valorant", "dota2", "dota", "r6", "rl"], k: 32, label: "Esports" },
};
export const MATCH_LABEL = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, v.label]));
const W_ELO = 0.25; // starting weight on Elo vs the crowd's price (unvalidated → small; tracked like everything else)
const parse = (x) => { try { return JSON.parse(x); } catch { return null; } };
const key = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const toAm = (p) => p <= 0 || p >= 1 ? null : p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const short = (n, sport) => { const clean = String(n).replace(/\s+(esports?|gaming|team|club|fc|e-?sports)$/i, "").trim() || String(n);
  if (sport === "ESPORTS") return clean; const w = clean.split(" "); return w.length > 1 && w[0].length > 2 ? w[w.length - 1] : clean; };

async function eventsFor(getJson, series, closed) {
  const out = [];
  for (let offset = 0; offset < (closed ? 1500 : 300); offset += 100) {
    const ev = await getJson(`https://gamma-api.polymarket.com/events?series_id=${series}&closed=${closed}&limit=100&offset=${offset}&order=${closed ? "endDate" : "startDate"}&ascending=${!closed}`);
    if (!Array.isArray(ev) || !ev.length) break; out.push(...ev); if (ev.length < 100) break;
  }
  return out;
}
function moneyline(e) {
  const mk = (e.markets || []).find((m) => m.sportsMarketType === "moneyline") || ((e.markets || []).length === 1 ? e.markets[0] : null);
  if (!mk) return null; const outs = parse(mk.outcomes), px = (parse(mk.outcomePrices) || []).map(Number);
  if (!outs || outs.length !== 2 || px.length !== 2) return null;
  return { outs, px, vol: +mk.volumeNum || 0, closed: !!mk.closed || !!e.closed };
}
const PALETTE = ["FFB547", "5CC8FF", "8F80FF", "45E0AE", "FF6F61", "F08FD0", "B8F25A", "FF9F5A", "6FA8FF", "E8E05A"];
const colorOf = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const elo = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

export async function matchCycle({ getJson, nowISO, ledger }) {
  const NOW = Date.parse(nowISO), list = (await getJson("https://gamma-api.polymarket.com/sports")) || [], slate = [], newPicks = [], log = [], graded = [];
  const have = new Set(ledger.map((r) => r.id));
  // a sport's matchup picks can be Hot only after 30+ graded picks that made money; until then Warm at most
  const proven = (sport) => { const G = ledger.filter((r) => r.sport === sport && r.status === "graded"); return G.length >= 30 && G.reduce((a, r) => a + (r.units || 0), 0) > 0; };
  for (const [sport, G] of Object.entries(GROUPS)) {
    const series = list.filter((x) => G.codes.includes(String(x.sport).toLowerCase()));
    let nRes = 0, nUp = 0;
    for (const s of series) {
      const title = String(s.sport).toUpperCase(), pool = sport === "ESPORTS" ? title : sport;
      const [closed, open] = await Promise.all([eventsFor(getJson, s.series, true), eventsFor(getJson, s.series, false)]);
      // results → Elo (oldest first)
      const R = new Map(), get = (n) => R.get(key(n)) || { r: 1500, n: 0 };
      const results = closed.map((e) => ({ e, m: moneyline(e) })).filter(({ m }) => m && m.px.some((p) => p >= 0.99) && m.px.some((p) => p <= 0.01))
        .sort((a, b) => (a.e.startTime || a.e.endDate || "") < (b.e.startTime || b.e.endDate || "") ? -1 : 1);
      for (const { e, m } of results) {
        const [a, b] = m.outs, A = get(a), B = get(b), pa = elo(A.r, B.r), ya = m.px[0] >= 0.99 ? 1 : 0, k = G.k * (A.n < 10 || B.n < 10 ? 1.5 : 1);
        R.set(key(a), { r: A.r + k * (ya - pa), n: A.n + 1 }); R.set(key(b), { r: B.r - k * (ya - pa), n: B.n + 1 }); nRes++;
        // grade any open EdgeBot pick on this event
        const id = `PM:${e.id}`;
        for (const row of ledger) if (row.gameId === id && row.status === "open") {
          const won = (row.side === "away" ? ya === 1 : ya === 0), dec = row.price > 0 ? 1 + row.price / 100 : 1 + 100 / -row.price;
          Object.assign(row, { status: "graded", result: won ? "W" : "L", final: `${m.outs[ya ? 0 : 1]} won`, gradedAt: nowISO, units: won ? dec - 1 : -1 }); graded.push(row);
        }
      }
      // upcoming → projections & picks
      for (const e of open) {
        const m = moneyline(e), start = e.startTime || e.endDate; if (!m || !start || Date.parse(start) < NOW - 3 * 3600e3 || Date.parse(start) > NOW + 7 * 864e5) continue;
        if (m.px.some((p) => p <= 0.01 || p >= 0.99)) continue; // settled or no market
        const [aN, hN] = m.outs, A = get(aN), H = get(hN), s2 = m.px[0] + m.px[1], mkA = m.px[0] / s2;
        const vol = +e.volume || 0, enough = A.n >= 15 && H.n >= 15 && vol >= 2000, eA = elo(A.r, H.r), wild = Math.abs(eA - mkA) > 0.22;
        const w = enough && !wild ? W_ELO : 0, pA = (1 - w) * mkA + w * eA;
        const g = { id: `PM:${e.id}`, sport, kind: "match", league: pool, title: e.title, start: new Date(start).toISOString(), status: Date.parse(start) <= NOW ? "in" : "pre",
          away: { abbr: short(aN, sport).slice(0, 14), name: aN, short: short(aN, sport), color: colorOf(aN), record: A.n ? `${Math.round(A.r)} Elo` : null }, home: { abbr: short(hN, sport).slice(0, 14), name: hN, short: short(hN, sport), color: colorOf(hN === aN ? hN + "x" : hN), record: H.n ? `${Math.round(H.r)} Elo` : null },
          spread: null, total: null, mlAway: toAm(m.px[0]), mlHome: toAm(m.px[1]), mlDraw: null,
          crowd: { pm: { away: m.px[0], home: m.px[1], vol: Math.round(+e.volume || 0), vol24: Math.round(+e.volume24hr || 0), mlVol: Math.round(m.vol), slug: e.slug }, pHome: 1 - mkA, pDraw: 0, money: Math.round(+e.volume || 0), money24: Math.round(+e.volume24hr || 0) },
          pred: { pHome: 1 - pA, pAway: pA, pDraw: 0, eloAway: Math.round(A.r), eloHome: Math.round(H.r), nA: A.n, nH: H.n, wr: w },
          why: [wild && enough ? `Elo (${short(aN, sport)} ${Math.round(eA * 100)}%) and the crowd (${Math.round(mkA * 100)}%) disagree too much to trust — EdgeBot follows the crowd here.` : enough ? `Elo ratings from ${A.n}+${H.n} verified ${G.label.toLowerCase()} results: ${short(aN, sport)} ${Math.round(A.r)} vs ${short(hN, sport)} ${Math.round(H.r)} → ${Math.round(eA * 100)}% for ${short(aN, sport)}.` : `Not enough to go on yet (${A.n} and ${H.n} verified results, 15+ needed; $${Math.round(vol).toLocaleString()} traded, $2,000+ needed), so EdgeBot follows the crowd’s price.`,
            `Crowd price (Polymarket, $${Math.round(+e.volume || 0).toLocaleString()} traded): ${short(aN, sport)} ${Math.round(mkA * 100)}%.`] };
        // pick: real edge vs the price on either side
        let pick = null;
        for (const [side, p, px] of [["away", pA, m.px[0]], ["home", 1 - pA, m.px[1]]]) {
          const edge = p - px / s2, ev = p / px - 1;
          if (enough && edge >= 0.025 && ev > 0 && (!pick || ev > pick.ev)) {
            const kelly = ev / (1 / px - 1), stake = Math.max(0.25, Math.min(2, Math.round(kelly * 100 / 4 * 4) / 4));
            pick = { market: "moneyline", side, label: `${short(side === "away" ? aN : hN, sport)} to win`, line: null, price: toAm(px), p, pRaw: p, pMkt: px / s2, edge, ev, fair: toAm(p), lane: "BUILDING", tier: edge >= 0.045 && proven(sport) ? "Value" : "Lean", stake: Math.min(stake, proven(sport) ? 2 : 0.5) };
          }
        }
        if (pick) { g.pick = pick; g.why.push(`${pick.label}: ${Math.round(pick.p * 100)}% vs ${Math.round(pick.pMkt * 100)}% priced in.`); }
        slate.push(g); nUp++;
        const id = `${g.id}~moneyline~${pick?.side}`;
        if (pick && g.status === "pre" && !have.has(id) && !ledger.some((r) => r.gameId === g.id)) {
          newPicks.push({ id, gameId: g.id, sport, start: g.start, matchup: `${aN} vs ${hN}`, home: g.home.abbr, away: g.away.abbr, market: "moneyline", side: pick.side, label: pick.label, line: null,
            price: pick.price, p: pick.p, pRaw: pick.p, pMkt: pick.pMkt, edge: pick.edge, ev: pick.ev, tier: pick.tier, stake: pick.stake, savedAt: nowISO, model: "edgebot-match-2", status: "open", crowdP: pick.pMkt });
          have.add(id);
        }
      }
    }
    log.push(`${G.label}: ${nRes} results learned, ${nUp} upcoming`);
  }
  return { slate, newPicks, graded, log };
}
