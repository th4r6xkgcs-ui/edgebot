# EdgeBot

Sports picks that learn from every final. **App:** https://th4r6xkgcs-ui.github.io/edgebot/ — on iPhone open it in Safari → Share → **Add to Home Screen**.

- **Free to run:** a GitHub Action (`.github/workflows/update.yml`) runs every hour. It reads ESPN's public scoreboards (no keys), learns team ratings from verified finals, saves picks before games start, grades them afterwards, and writes everything to the `data` branch (overwritten each run, so the repo stays small).
- **Model (`engine.js`):** per-sport team ratings (margin + scoring) blended with the betting market. The blend weight is learned from which source predicted recent finals better (capped at 55% on EdgeBot's own ratings). Picks need a real price edge; each sport × market lane is calibrated from its own graded record, and struggling lanes are capped at Lean.
- **App (`index.html`):** Picks · Games (10,000 simulations per game on the phone, check your own line) · Record (which models are working) · HQ (3D ops floor).
- Sports: NBA, NFL, college football (FBS), NHL, MLB, Premier League.

Research only. EdgeBot never places bets, and nothing here is a guarantee.

Run locally: `node scripts/update.mjs` (writes `data/`), then serve the folder with any static server.
