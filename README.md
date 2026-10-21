# EdgeBot

Sports picks that learn from every final. **App:** https://th4r6xkgcs-ui.github.io/edgebot/ — on iPhone open it in Safari → Share → **Add to Home Screen**.

- **Free to run:** a GitHub Action (`.github/workflows/update.yml`) runs every hour. It reads ESPN's public scoreboards (no keys), learns team ratings from verified finals, saves picks before games start, grades them afterwards, and writes everything to the `data` branch (overwritten each run, so the repo stays small).
- **Data:** ESPN scoreboards and injury reports, nflverse NFL history (closing lines, rest, stadiums; CC-BY 4.0), Open-Meteo wind forecasts. Ratings are rebuilt every run from an archive of verified finals, with last season carried in at 70%.
- **The crowd:** Polymarket and Kalshi (public market data APIs) show where real money is going on each game — price, money traded, 24h volume and movement — next to the sportsbooks, ESPN's Matchup Predictor and EdgeBot. They're shown and logged with each pick, but don't move picks until tested.
- **Tested, not guessed:** NFL settings and effects were checked against ~3,100 games and their closing lines (2015–2025). Only effects that held up in both 2015–19 and 2020–25 are used: 15+ mph wind (unders ~55%) and an away rest edge of 3+ days (away covers ~54%). Ratings alone add ~nothing over NFL closing lines, so the NFL blend learns ≈0% and NFL picks come from those effects.
- **Model (`engine.js`):** per-sport team ratings (margin + scoring) blended with the betting market. The blend weight is learned from which source predicted recent finals better (capped at 55% on EdgeBot's own ratings). Picks need a real price edge; each sport × market lane is calibrated from its own graded record, and struggling lanes are capped at Warm.
- **Players (`scripts/players.mjs`):** projections for every NBA/NFL player with a DraftKings prop line (via ESPN) — recent games weighted most, minutes and opponent defence for NBA, nflverse weekly stats for NFL — blended 40/60 with the line. Higher/Lower picks at 57%+, saved before the game and graded from the box score. Underdog's own lines aren't available from a permitted source; check the line in the app.
- **App (`index.html`):** Picks · Games · Players (10,000 simulations per game on the phone, check your own line) · Record (which models are working) · HQ (3D ops floor).
- **Pick strength:** 🔥 Warm (2.5–4.5 pt edge), 🔥🔥 Hot (4.5+), 🔥🔥🔥 Fire (7+ from a proven sport/market).
- Sports: NBA, NFL, college football (FBS), NHL, MLB, Premier League.

Research only. EdgeBot never places bets, and nothing here is a guarantee.

Run locally: `node scripts/update.mjs` (writes `data/`), then serve the folder with any static server.
