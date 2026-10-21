const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const tries = [
  ["pm sports", "https://gamma-api.polymarket.com/sports"],
  ["pm nba events", "https://gamma-api.polymarket.com/events?tag_slug=nba&closed=false&limit=3&order=volume24hr&ascending=false"],
  ["pm nfl events", "https://gamma-api.polymarket.com/events?tag_slug=nfl&closed=false&limit=3&order=volume24hr&ascending=false"],
  ["kalshi nba", "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNBAGAME&status=open&limit=2"],
  ["kalshi nfl", "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNFLGAME&status=open&limit=2"],
  ["kalshi nhl", "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNHLGAME&status=open&limit=2"],
  ["kalshi ncaaf", "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNCAAFGAME&status=open&limit=2"],
  ["kalshi epl", "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXEPLGAME&status=open&limit=2"],
  ["espn nfl summary", "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401873015"],
];
for (const [name, url] of tries) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) }); const t = await r.text();
    let info = t.slice(0, 600).replace(/\s+/g, " ");
    if (name.startsWith("espn")) { const j = JSON.parse(t); info = "keys=" + Object.keys(j).join(",") + " | pickcenter=" + JSON.stringify(j.pickcenter?.[0] || null).slice(0, 400) + " | predictor=" + JSON.stringify(j.predictor || null).slice(0, 200) + " | ats=" + JSON.stringify(j.againstTheSpread || null).slice(0, 200); }
    console.log(`::notice::${name}: ${r.status} ${t.length}b ${info}`);
  } catch (e) { console.log(`::notice::${name}: ERR ${e.message}`); }
}
