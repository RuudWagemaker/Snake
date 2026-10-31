# Curve Royale

**Curve Fever + slither.io + battle royale**, in the browser.

Every player is a line that never stops moving. You can only steer left or right.
Touch any line, including your own, and you're out. The arena is huge, like slither.io,
and a zone closes in over time until one snake is left.

Open the site, press **Play**, and you're in a match within a few seconds. Bots fill
empty seats, so there's always a game, even when you're alone.

## Controls

| Platform | Steer |
| --- | --- |
| Keyboard | `←` `→` or `A` `D` |
| Phone / tablet | hold the left or right half of the screen |
| Mouse | hold the left or right half of the screen |
| Gamepad | left stick, d-pad or shoulder buttons |

It runs in any modern browser (desktop, Android, iOS) and can be installed to the
home screen as a PWA, where it runs fullscreen.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Test with a bad network (one-way delay plus random jitter):

```bash
SIM_LAG_MS=75 SIM_JITTER_MS=40 npm start
```

Add `?debug` to the URL to expose `window.__cr` (game state, netcode stats) in the console.

Run the tests: `npm test`

## Deploy

### Render (free, easiest)

The repo includes a `render.yaml` blueprint.

The service runs in Frankfurt (`region` in `render.yaml`). Pick the region closest
to your players, because ping matters a lot in this game. Render can't move an existing
service, so changing it means deleting the service and creating it again.

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub.
2. **New > Blueprint**, pick this repository, then **Apply**.
3. After a couple of minutes the game is live at `https://curve-royale-xxxx.onrender.com`.

Every push to the branch redeploys automatically. The free plan sleeps after 15
minutes without visitors, and the first visit after that takes about a minute to wake it.
A paid instance stays awake.

### Anywhere else

It's one Node.js process serving both the website and the WebSocket (`/ws`), so any
host that runs Node or Docker works (Fly.io, Render, Railway, a VPS, ...).

```bash
docker build -t curve-royale .
docker run -p 3000:3000 curve-royale
```

The server reads `PORT` from the environment. Use HTTPS in production: the client
automatically connects with `wss://` when the page is served over `https://`.
Health check: `GET /healthz`.

## How it works

```
public/shared/   rules shared by server and client (physics, gaps, zone, collisions, wire format)
public/client/   browser client (canvas rendering, input, prediction)
server/          Node.js server (matchmaking, rooms, authoritative simulation, bots)
```

### Server is in charge (no cheating)

* The server runs the only real simulation at 30 ticks/s. It decides positions,
  collisions, kills and the winner.
* A client only sends "left / straight / right" for each tick. It can't send
  positions, so there's nothing to fake. The server ignores malformed or excess input.

### But it feels instant (client-side prediction)

* **Your snake:** your input is applied locally right away, using the exact same rules
  (`public/shared/sim.js`) as the server. Each server update says which of your inputs
  it has processed. The client rewinds to the server's state and replays the rest
  (reconciliation). State is kept as float32 on both sides and gap timing comes from a
  shared seed, so the replay usually matches the server exactly. When it doesn't (a late
  packet), the small difference is blended out over ~100 ms instead of snapping.
* **Other snakes:** shown slightly in the past and interpolated between server ticks.
  The client measures how unevenly updates arrive and adjusts the delay (about 70 ms on a
  good connection, more on a jittery one), so other snakes never freeze or jump.
* **Input pacing:** the server reports how many of your inputs it has queued, and flags
  every tick where your input arrived too late. The client sends slightly faster or
  slower to keep the smallest queue at about one input. A bad connection automatically
  gets a bigger buffer, and a good one gets almost none.
* State updates are compact binary (14 bytes per snake per tick). Everything else is JSON.

### Match flow

1. **Lobby:** the first player starts a 5 s timer. Up to 24 humans can join, and bots
   fill up to 10 players.
2. **Countdown:** 3 s, with everyone frozen and showing which way they're facing.
3. **Play:** the zone holds, then shrinks in 5 phases to zero. Each new circle sits
   inside the previous one and is shown dashed in advance. The field size scales with
   the number of players.
4. **End:** results for 6 s, then the next round starts in the same room. Press
   *Play again* after dying to jump straight into a new match instead.

Tuning lives in `public/shared/constants.js` (speed, turn rate, line width, gaps,
player counts, zone phases).
