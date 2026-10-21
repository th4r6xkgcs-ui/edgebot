/* EdgeBot engine v2 — shared by the app page and the scheduled runner. Pure functions, no I/O.
   Model per sport: team point ratings learned from every verified final (margin + scoring),
   blended with the betting market. The blend weight is itself learned from which source
   predicted recent finals better. Picks need a price edge; every pick is saved before the
   game and graded after; lane calibration corrects over/under-confidence. */
(function (root) {
  const SPORTS = {
    NBA:   { label: "NBA", path: "basketball/nba", sdM: 12.5, sdT: 18, hfa: 2.2, k: 0.07, kt: 0.05, avgT: 228, dist: "normal", draw: false, ot: false },
    NFL:   { label: "NFL", path: "football/nfl", sdM: 13.5, sdT: 13, hfa: 1.6, k: 0.10, kt: 0.06, avgT: 45, dist: "normal", draw: false, ot: false },
    NCAAF: { label: "College FB", path: "football/college-football", sdM: 16, sdT: 16, hfa: 2.8, k: 0.10, kt: 0.06, avgT: 55, dist: "normal", draw: false, ot: false },
    NHL:   { label: "NHL", path: "hockey/nhl", sdM: 2.4, sdT: 2.3, hfa: 0.2, k: 0.05, kt: 0.03, avgT: 6.1, dist: "poisson", draw: false, ot: true },
    MLB:   { label: "MLB", path: "baseball/mlb", sdM: 4.3, sdT: 4.4, hfa: 0.2, k: 0.04, kt: 0.03, avgT: 8.8, dist: "negbin", draw: false, ot: true },
    EPL:   { label: "Premier League", path: "soccer/eng.1", sdM: 1.7, sdT: 1.6, hfa: 0.3, k: 0.06, kt: 0.03, avgT: 2.9, dist: "poisson", draw: true, ot: false },
  };
  const MODEL_VERSION = "edgebot-v2.1";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
  const ncdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const toDec = (american) => american == null || !isFinite(american) || american === 0 ? null : american > 0 ? 1 + american / 100 : 1 + 100 / -american;
  const toAm = (p) => p <= 0 || p >= 1 ? null : p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);

  /* -------- ratings -------- */
  function emptyRatings(sport) { return { sport, teams: {}, lg: { avgT: SPORTS[sport].avgT, n: 0 }, seen: [], blend: { seM: 0, seR: 0, n: 0 } }; }
  const team = (R, abbr) => R.teams[abbr] || { r: 0, o: 0, d: 0, n: 0 };
  /** Weight on EdgeBot's own ratings (vs market), learned from squared errors on recent finals. */
  /** Starting trust in EdgeBot's own ratings before enough finals have been scored against the closing line. */
  const PRIOR_WEIGHT = 0.15;
  function ratingWeight(R) {
    const b = R.blend || { n: 0 }; if (b.n < 15) return PRIOR_WEIGHT;
    const learned = clamp(b.seM / (b.seM + b.seR), 0.1, 0.55);
    return b.n >= 40 ? learned : PRIOR_WEIGHT + (learned - PRIOR_WEIGHT) * (b.n - 15) / 25;
  }
  function invNorm(p) { // Acklam's rational approximation
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924],
      b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857],
      c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878],
      d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742], pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) return -invNorm(1 - p);
    const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  /** Market expected home margin: from the spread (negative = home favored), else implied by the moneyline. */
  function marketMargin(g) {
    if (g.spread != null) return -g.spread;
    if (g.mlHome != null && g.mlAway != null) {
      const S = SPORTS[g.sport], ph = 1 / toDec(g.mlHome), pa = 1 / toDec(g.mlAway);
      const p = clamp(ph / (ph + pa), 0.03, 0.97); // win share, draws excluded
      return S.sdM * invNorm(p) + (S.draw ? 0 : 0);
    }
    return null;
  }
  function predictFromMargin(S, margin) {
    const pHome = S.draw ? 1 - ncdf((0.5 - margin) / S.sdM) : 1 - ncdf(-margin / S.sdM);
    const pDraw = S.draw ? ncdf((0.5 - margin) / S.sdM) - ncdf((-0.5 - margin) / S.sdM) : 0;
    return { pHome, pDraw };
  }
  function predict(g, R) {
    const S = SPORTS[g.sport], h = team(R, g.home.abbr), a = team(R, g.away.abbr);
    const ratingM = h.r - a.r + S.hfa, ratingT = R.lg.avgT + h.o + a.d + a.o + h.d;
    const evidence = Math.min(h.n, a.n), wr0 = ratingWeight(R), wr = evidence < 6 ? 0 : evidence < 10 ? wr0 * (evidence - 5) / 5 : wr0;
    const mM = marketMargin(g), mT = g.total;
    const margin = mM == null ? (evidence >= 3 ? ratingM : null) : (1 - wr) * mM + wr * ratingM;
    const total = mT == null ? (evidence >= 3 ? ratingT : null) : (1 - wr) * mT + wr * ratingT;
    if (margin == null) return null;
    const pHome = S.draw ? 1 - ncdf((0.5 - margin) / S.sdM) : 1 - ncdf(-margin / S.sdM);
    const pDraw = S.draw ? ncdf((0.5 - margin) / S.sdM) - ncdf((-0.5 - margin) / S.sdM) : 0;
    return { margin, total: total ?? R.lg.avgT, pHome, pAway: 1 - pHome - pDraw, pDraw, wr, ratingM, ratingT, marketM: mM, marketT: mT, evidence,
      homeRating: h, awayRating: a, blendN: (R.blend || {}).n || 0, version: MODEL_VERSION };
  }
  /** Learn from one verified final. Idempotent via R.seen. */
  function learn(R, g) {
    if (g.status !== "post" || g.home.score == null || g.away.score == null || R.seen.includes(g.id)) return false;
    const S = SPORTS[g.sport], pred = predict(g, R), act = g.home.score - g.away.score, actT = g.home.score + g.away.score;
    const h = { ...team(R, g.home.abbr) }, a = { ...team(R, g.away.abbr) };
    const expM = h.r - a.r + S.hfa, expT = R.lg.avgT + h.o + a.d + a.o + h.d, err = clamp(act - expM, -3 * S.sdM, 3 * S.sdM), errT = clamp(actT - expT, -3 * S.sdT, 3 * S.sdT);
    if (pred && pred.marketM != null && h.n >= 6 && a.n >= 6) {
      R.blend.seM += (act - pred.marketM) ** 2; R.blend.seR += (act - expM) ** 2; R.blend.n++;
      if (R.blend.n > 400) { R.blend.seM *= 400 / R.blend.n; R.blend.seR *= 400 / R.blend.n; R.blend.n = 400; }
    }
    const k = S.k * (h.n < 5 || a.n < 5 ? 2 : 1);
    h.r += k * err; a.r -= k * err;
    h.o += S.kt * errT / 4; a.o += S.kt * errT / 4; h.d += S.kt * errT / 4; a.d += S.kt * errT / 4;
    h.n++; a.n++; R.teams[g.home.abbr] = h; R.teams[g.away.abbr] = a;
    R.lg.avgT += 0.01 * (actT - R.lg.avgT); R.lg.n++;
    R.seen.push(g.id); if (R.seen.length > 1500) R.seen = R.seen.slice(-1200);
    return true;
  }
  /** Market prior: when a team has no results yet, start its rating from the line (keeps early picks honest). */
  function seedFromMarket(R, g) {
    const mM = marketMargin(g); if (mM == null) return;
    const S = SPORTS[g.sport], h = team(R, g.home.abbr), a = team(R, g.away.abbr);
    if (h.n === 0 && !R.teams[g.home.abbr]) R.teams[g.home.abbr] = { ...h, r: a.r + (mM - S.hfa) / (R.teams[g.away.abbr] ? 1 : 2) };
    if (a.n === 0 && !R.teams[g.away.abbr]) R.teams[g.away.abbr] = { ...a, r: team(R, g.home.abbr).r - (mM - S.hfa) };
  }

  /* -------- prices & picks -------- */
  function noVig(ps) { const s = ps.reduce((x, y) => x + y, 0); return ps.map((p) => p / s); }
  function laneAdjust(p, lane) { if (!lane || lane.n < 10) return p; const bias = (lane.sumY - lane.sumP) / (lane.n + 40); return clamp(p + bias, 0.02, 0.98); }
  function laneState(lane) {
    if (!lane || lane.n < 30) return "BUILDING";
    const brier = lane.brier / lane.n, base = lane.base / lane.n;
    return brier <= base ? "PROVEN" : brier > base + 0.01 ? "STRUGGLING" : "BUILDING";
  }
  function candidates(g, pred, lanes) {
    const S = SPORTS[g.sport], out = [], H = g.home.abbr, A = g.away.abbr;
    const push = (market, side, label, line, price, pRaw, pMkt) => {
      if (pRaw == null || pMkt == null) return;
      const lane = lanes[`${g.sport}|${market}`], p = laneAdjust(pRaw, lane), dec = toDec(price ?? -110);
      const edge = p - pMkt, ev = p * dec - 1;
      out.push({ market, side, label, line, price: price ?? -110, p, pRaw, pMkt, edge, ev, fair: toAm(p), lane: laneState(lane) });
    };
    if (g.mlHome != null && g.mlAway != null) {
      const imp = [g.mlHome, g.mlAway, ...(S.draw && g.mlDraw != null ? [g.mlDraw] : [])].map((m) => 1 / toDec(m)), nv = noVig(imp);
      // Anchor to the market's own moneyline: only the part of our margin that differs from the market's
      // margin moves the probability (spread->ML conversion differences are not edges).
      let dH = 0, dD = 0;
      if (pred.marketM != null) {
        const mk = predictFromMargin(S, pred.marketM), md = predictFromMargin(S, pred.margin);
        dH = md.pHome - mk.pHome; dD = md.pDraw - mk.pDraw;
      } else { dH = pred.pHome - nv[0]; dD = S.draw ? pred.pDraw - (nv[2] ?? 0) : 0; }
      const pH = clamp(nv[0] + dH, 0.01, 0.99), pD = S.draw && nv[2] != null ? clamp(nv[2] + dD, 0.01, 0.6) : 0;
      push("moneyline", "home", `${H} ML`, null, g.mlHome, pH, nv[0]);
      push("moneyline", "away", `${A} ML`, null, g.mlAway, clamp(1 - pH - pD, 0.01, 0.99), nv[1]);
      if (S.draw && g.mlDraw != null) push("moneyline", "draw", "Draw", null, g.mlDraw, pD, nv[2]);
    }
    if (g.spread != null) {
      const coverH = 1 - ncdf((-g.spread - pred.margin) / S.sdM);
      const fmt = (x) => (x > 0 ? "+" : "") + x;
      push("spread", "home", `${H} ${fmt(g.spread)}`, g.spread, g.spreadPriceHome, coverH, 0.5);
      push("spread", "away", `${A} ${fmt(-g.spread)}`, -g.spread, g.spreadPriceAway, 1 - coverH, 0.5);
    }
    if (g.total != null) {
      const over = 1 - ncdf((g.total - pred.total) / S.sdT);
      push("total", "over", `Over ${g.total}`, g.total, g.overPrice, over, 0.5);
      push("total", "under", `Under ${g.total}`, g.total, g.underPrice, 1 - over, 0.5);
    }
    return out;
  }
  function tierOf(c) {
    if (c.ev <= 0 || c.edge < 0.025) return null;
    if (c.lane === "STRUGGLING") return "Lean";
    if (c.edge >= 0.07 && c.lane === "PROVEN") return "Strong";
    return c.edge >= 0.045 ? "Value" : "Lean";
  }
  function bestPick(g, pred, lanes) {
    if (!pred) return null;
    const cs = candidates(g, pred, lanes).map((c) => ({ ...c, tier: tierOf(c) })).filter((c) => c.tier).sort((x, y) => y.ev - x.ev);
    return cs[0] || null;
  }
  function why(g, pred, pick) {
    const S = SPORTS[g.sport], r = [], H = g.home.abbr, A = g.away.abbr, f1 = (x) => (Math.round(x * 10) / 10).toString();
    if (pred.marketM != null) r.push(`Market line: ${pred.marketM >= 0 ? H : A} by ${f1(Math.abs(pred.marketM))}.`);
    if (pred.evidence >= 3) r.push(`EdgeBot ratings (${pred.homeRating.n}+${pred.awayRating.n} verified games): ${pred.ratingM >= 0 ? H : A} by ${f1(Math.abs(pred.ratingM))}, total ${f1(pred.ratingT)}.`);
    else r.push(`Ratings still building (${pred.evidence} verified games for the thinner team; 6+ needed), so the market sets this projection.`);
    r.push(`Blend: ${Math.round(pred.wr * 100)}% EdgeBot ratings, ${Math.round((1 - pred.wr) * 100)}% market. ${(R0 => R0)(pred.blendN) >= 15 ? `Set from ${pred.blendN} ${S.label} finals scored against the closing line.` : `Starting weight until 15 ${S.label} finals are scored against the closing line (${pred.blendN || 0} so far).`}`);
    if (pick) r.push(`${pick.label}: ${Math.round(pick.p * 100)}% vs ${Math.round(pick.pMkt * 100)}% priced in (fair odds ${pick.fair > 0 ? "+" : ""}${pick.fair}).`);
    return r;
  }

  /* -------- simulation -------- */
  function poisson(r, lam) { if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss(r))); let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }
  function gamma(r, k) { if (k < 1) return gamma(r, k + 1) * Math.pow(r(), 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = gauss(r); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = r(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }
  function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
  function simulate(g, pred, n = 10000) {
    const S = SPORTS[g.sport], r = rng(hash(`${g.id}|${MODEL_VERSION}|${pred.margin.toFixed(3)}|${pred.total.toFixed(3)}`));
    const muH = Math.max(0.2, (pred.total + pred.margin) / 2), muA = Math.max(0.2, (pred.total - pred.margin) / 2);
    let hw = 0, aw = 0, dr = 0, cover = 0, push = 0, over = 0, under = 0; const scores = new Map(), margins = [];
    for (let i = 0; i < n; i++) {
      let h, a;
      if (S.dist === "normal") {
        const z1 = gauss(r), z2 = gauss(r), m = pred.margin + S.sdM * z1, t = pred.total + S.sdT * (0.15 * z1 + 0.99 * z2);
        h = Math.max(0, Math.round((t + m) / 2)); a = Math.max(0, Math.round((t - m) / 2));
        if (h === a) (r() < ncdf(pred.margin / 4) ? h++ : a++);
      } else if (S.dist === "poisson") { h = poisson(r, muH); a = poisson(r, muA); }
      else { const sh = 6; h = poisson(r, gamma(r, sh) * muH / sh); a = poisson(r, gamma(r, sh) * muA / sh); }
      let reg = true;
      if (h === a && S.ot) { reg = false; if (r() < muH / (muH + muA)) h++; else a++; }
      if (h > a) hw++; else if (a > h) aw++; else dr++;
      if (g.spread != null) { const d = h - a + g.spread; if (d > 0) cover++; else if (d === 0) push++; }
      if (g.total != null) { const t = h + a; if (t > g.total) over++; else if (t < g.total) under++; }
      const key = `${h}-${a}`; scores.set(key, (scores.get(key) || 0) + 1); margins.push(h - a); void reg;
    }
    margins.sort((x, y) => x - y);
    const q = (p) => margins[Math.floor(p * (n - 1))];
    return { n, home: hw / n, away: aw / n, draw: dr / n, cover: g.spread != null ? cover / n : null, push: g.spread != null ? push / n : null,
      over: g.total != null ? over / n : null, under: g.total != null ? under / n : null,
      top: [...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([s, c]) => ({ s, p: c / n })),
      range: [q(0.1), q(0.5), q(0.9)], muH, muA };
  }

  /* -------- grading -------- */
  function grade(pick, g) {
    if (g.status !== "post" || g.home.score == null) return null;
    const h = g.home.score, a = g.away.score;
    if (pick.market === "moneyline") return pick.side === "home" ? (h > a ? "W" : "L") : pick.side === "away" ? (a > h ? "W" : "L") : (h === a ? "W" : "L");
    if (pick.market === "spread") { const d = pick.side === "home" ? h - a + pick.line : a - h + pick.line; return d > 0 ? "W" : d < 0 ? "L" : "P"; }
    if (pick.market === "total") { const t = h + a; if (t === pick.line) return "P"; return (pick.side === "over") === (t > pick.line) ? "W" : "L"; }
    return null;
  }
  const profit = (res, price) => res === "W" ? toDec(price) - 1 : res === "L" ? -1 : 0;

  /* -------- one learning cycle (used by the scheduled runner) -------- */
  function runCycle(input) {
    const now = Date.parse(input.now), ratings = input.ratings || {}, model = input.model || { lanes: {}, runs: 0 };
    model.lanes ||= {};
    const games = (input.games || []).filter((g) => SPORTS[g.sport]).sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    const touched = new Set(), log = [];
    let learned = 0;
    for (const g of games) { const R = (ratings[g.sport] ||= emptyRatings(g.sport)); if (learn(R, g)) { learned++; touched.add(g.sport); } }
    for (const g of games) if (g.status === "pre") { const R = (ratings[g.sport] ||= emptyRatings(g.sport)); seedFromMarket(R, g); touched.add(g.sport); }
    // grade open ledger picks
    const byId = new Map(games.map((g) => [g.id, g])), graded = [];
    for (const row of input.openLedger || []) {
      const g = byId.get(row.gameId); if (!g) continue; const res = grade(row, g); if (!res) continue;
      const laneKey = `${row.sport}|${row.market}`, L = (model.lanes[laneKey] ||= { n: 0, w: 0, l: 0, p: 0, sumP: 0, sumY: 0, brier: 0, base: 0, units: 0 });
      if (res === "P") L.p++; else { const y = res === "W" ? 1 : 0; L.n++; res === "W" ? L.w++ : L.l++; L.sumP += row.pRaw; L.sumY += y; L.brier += (row.pRaw - y) ** 2; L.base += (row.pMkt - y) ** 2; }
      L.units += profit(res, row.price);
      graded.push({ id: row.id, result: res, final: `${g.away.abbr} ${g.away.score} – ${g.home.abbr} ${g.home.score}`, gradedAt: input.now, units: profit(res, row.price) });
    }
    // slate + new picks
    const slate = [], newPicks = [], existing = new Set(input.ledgerIds || []);
    for (const g of games) {
      const start = Date.parse(g.start); if (start < now - 36 * 3600e3) continue;
      const R = ratings[g.sport], pred = R ? predict(g, R) : null, pick = g.status === "pre" && pred ? bestPick(g, pred, model.lanes) : null;
      slate.push({ ...g, pred: pred && { margin: pred.margin, total: pred.total, pHome: pred.pHome, pAway: pred.pAway, pDraw: pred.pDraw, wr: pred.wr, ratingM: pred.ratingM, ratingT: pred.ratingT, marketM: pred.marketM, marketT: pred.marketT, evidence: pred.evidence, nH: pred.homeRating.n, nA: pred.awayRating.n },
        pick, why: pred ? why(g, pred, pick) : ["No line or ratings yet for this game."] });
      if (pick && start > now) {
        const id = `${g.id}~${pick.market}~${pick.side}`;
        if (!existing.has(id)) newPicks.push({ id, gameId: g.id, sport: g.sport, start: g.start, matchup: `${g.away.abbr} @ ${g.home.abbr}`, home: g.home.abbr, away: g.away.abbr,
          market: pick.market, side: pick.side, label: pick.label, line: pick.line, price: pick.price, p: pick.p, pRaw: pick.pRaw, pMkt: pick.pMkt, edge: pick.edge, ev: pick.ev, tier: pick.tier,
          savedAt: input.now, model: MODEL_VERSION, status: "open" });
      }
    }
    // backfill cursor: earliest verified final seen per sport (the runner fetches days before it)
    model.backfill ||= {};
    for (const g of games) if (g.status === "post") { const d = g.start.slice(0, 10); if (!model.backfill[g.sport] || d < model.backfill[g.sport]) model.backfill[g.sport] = d; }
    model.runs = (model.runs || 0) + 1; model.lastRun = input.now; model.version = MODEL_VERSION;
    model.lastSummary = { games: games.length, finalsLearned: learned, graded: graded.length, newPicks: newPicks.length, sports: [...new Set(games.map((g) => g.sport))] };
    model.blend = Object.fromEntries(Object.entries(ratings).map(([s, R]) => [s, { weight: ratingWeight(R), n: R.blend.n, teams: Object.keys(R.teams).length, finals: R.lg.n }]));
    log.push(`${games.length} games read, ${learned} new finals learned, ${graded.length} picks graded, ${newPicks.length} new picks saved.`);
    return { ratings, touched: [...touched], model, slate, newPicks, graded, log };
  }

  const api = { SPORTS, MODEL_VERSION, predict, learn, simulate, candidates, bestPick, grade, profit, runCycle, emptyRatings, ratingWeight, laneState, toDec, toAm, ncdf, why };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EdgeEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
