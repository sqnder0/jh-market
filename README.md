# Beurssimulatie

A market simulation to run alongside the live-action business game: a ticking
game clock, a price board the kids watch, a dealer's desk where trades are
booked, a private share list for the businessman, and an admin panel that can
push any price up or down.

Everything runs from one Node process with **no dependencies and no build step**.
Every page subscribes to the same server-sent event stream, so all screens stay
in sync.

```bash
npm start          # http://localhost:4173
npm run dev        # same, restarts on file changes
npm test           # simulation engine test suite
PORT=8080 npm start
```

## The pages

| URL | Who looks at it | What it is |
|---|---|---|
| `/` | you | Hub: live status and links to everything |
| `/clock` | **projector** | The game clock, 09:00 → 19:00, with the beurs and casino windows |
| `/market` | **projector** | The board: price chart and quotes. Read only — no buttons |
| `/desk` | dealer only | Trade ticket, positions and the running book |
| `/private` | businessman only | His private shares, big numbers, deliberately no chart |
| `/admin` | game leader only | Businesses, day schedule, clock speed, price pushes |

## The clock

A game day is a cycle from **09:00 to 19:00**. At 19:00 it rolls straight back
to 09:00 and the day counter ticks over. Inside the day:

- **Beurs (exchange) 09:00 – 17:00.** Listed prices only move while it is open;
  outside those hours the chart draws a flat, shaded "beurs dicht" stretch and
  the desk refuses trades in listed shares.
- **Casino 15:00 – 19:00.** Shown as a status everywhere; it has no effect on
  prices, it is there so the room can see it.

Speed is set as **how many real minutes one game hour takes** (default 5, so a
full day is 50 real minutes). The clock page shows what that buys you: at 5
minutes per hour, a 90-minute session runs ~18 game hours, about 1.8 game days.
Turn the dial down if you want closer to three days in the same session.

All six hours are editable on the admin page if you want a different shape.

## The market model

Each business has four knobs, all per simulated minute and all edited as
percentages on the admin page:

- **Beweeglijkheid (volatility)** — the size of a typical one-minute wobble.
- **Trend (drift)** — a steady lean up or down. Private shares get a higher
  trend, which is what makes their ROI better.
- **Zwaartekracht (gravity / mean reversion)** — how hard the price is pulled
  back toward its richtprijs (fair value). Set it to 0 for a pure random walk.
- **Richtprijs** — the fair value gravity pulls toward.

Prices follow `price × exp(drift + gravity·ln(richtprijs/price) + σ·noise)`,
so they can never go negative.

### Pushing a price

On the admin card for any business:

- The quick buttons (**±1 / ±5 / ±10%**) move the price instantly.
- **Campagne starten** spreads a move evenly over N simulated minutes — good for
  a rumour that leaks out over an hour rather than a jump the room can't miss.
- **Blijvend** also moves the richtprijs. Leave it on for a real re-rating; turn
  it off and gravity will drag the price back where it came from, which is how
  you make a bubble that pops on its own.

### Public vs private

`market: 'public'` listings appear on the board and in the chart. `market:
'private'` ones appear only on `/private` and on the dealer's desk — no chart,
no legend, no colour on the board. Private shares also stay tradeable outside
exchange hours and keep moving after the bell.

## State

State lives in `data/state.json`, written a couple of seconds after every
change and on shutdown, so a restart resumes exactly where the game was.
Delete that file (or use **Gevarenzone → Hele markt terug naar de standaard**)
for a clean slate.

## Deploying

Built for [Nixpacks](https://nixpacks.com) — Railway, Coolify, Dokploy and
friends detect `nixpacks.toml` and need no further setup. The build installs
nothing (there are no dependencies) and runs the test suite as a gate; the
start command is `node src/server.js`.

```bash
nixpacks build . --name jh-market   # to check the build locally
docker run -p 4173:4173 jh-market
```

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `4173` | Port to listen on. Most platforms set this for you. |
| `HOST` | `0.0.0.0` | Interface to bind. Leave alone in a container. |
| `DATA_DIR` | `./data` | Where `state.json` is written. |

`GET /api/health` returns `{ ok, day, time, running, businesses, uptimeSeconds }`
for platform health checks.

**Point `DATA_DIR` at a mounted volume.** Container filesystems are ephemeral, so
without one every redeploy resets the game to day 1 — fine while you are still
building it, bad halfway through a session.

**There is no authentication.** Anyone with the URL can open `/admin` and move
every price. If it is reachable from the internet, put it behind whatever access
control your platform offers, or only deploy it on the network the game runs on.

## Layout

```
nixpacks.toml    deployment build/start config
src/sim.js       the simulation: clock, schedule, prices, portfolio  (all logic)
src/server.js    static files, JSON command API, SSE broadcast, health check
public/*.html    one file per page
public/js/       common.js (SSE + formatting), dom.js (list diffing),
                 chart.js (canvas chart), one script per page
test/            engine tests — node --test
```

The server is authoritative: pages send commands and render what comes back,
they never compute a price themselves.
