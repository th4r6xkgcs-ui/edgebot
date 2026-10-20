const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const tries = [
  ["site.api plain", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261020", {}],
  ["site.api browser", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261020", { "User-Agent": UA, Accept: "application/json", Referer: "https://www.espn.com/" }],
  ["site.web.api browser", "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261020", { "User-Agent": UA, Accept: "application/json", Referer: "https://www.espn.com/" }],
  ["site.web.api plain", "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261020", {}],
  ["cdn core", "https://cdn.espn.com/core/nba/scoreboard?xhr=1&dates=20261020", { "User-Agent": UA }],
  ["sports.core", "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events?dates=20261020", { "User-Agent": UA }],
  ["nhl official", "https://api-web.nhle.com/v1/score/2026-10-20", { "User-Agent": UA }],
  ["mlb official", "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-20", { "User-Agent": UA }],
];
for (const [name, url, headers] of tries) {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); const t = await r.text(); console.log(`${name}: ${r.status} ${t.length}b ${t.slice(0, 80).replace(/\s+/g, " ")}`); }
  catch (e) { console.log(`${name}: ERR ${e.message}`); }
}
