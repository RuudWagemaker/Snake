# Curve Royale

**Curve Fever + slither.io + battle royale**, in the browser.

Every player is a line that never stops moving. You can only steer left or right.
Touch any line, including your own, and you're out. The arena is huge, like slither.io,
and a zone closes in over time until one snake is left.

Open the site, press **Play**, and you're in a match within a few seconds. Bots fill
empty seats, so there's always a game, even when you're alone.

## Power-ups

Power-ups lie around the arena (fewer as the zone shrinks). Drive through one to
collect it.

| | Power-up | Effect | Time |
| --- | --- | --- | --- |
| Green (you) | ⚡ Speed | you move 1.6× faster | 5 s |
| | 👻 Ghost | no line behind you, and you pass through lines (not the zone) | 3 s |
| | │ Thin | your line is half as wide | 6 s |
| Red (opponents near you) | » Fast | they move 1.6× faster | 4 s |
| | ▬ Fat | their lines are twice as thick | 5 s |
| | ⇄ Reverse | their left and right are swapped | 3.5 s |

The same power-up stacks. Red ones hit opponents within about a screen's distance of
the picker, not the whole map. An effect starts 0.27 s after the pickup, so every
client knows about it before it kicks in, which keeps movement prediction exact.
Bots steer toward power-ups that are close and safe to reach.

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

Test with a bad network (one-way delay plus random jitter), or a server that
freezes for a moment every 4 s (like a CPU-starved host):

```bash
SIM_LAG_MS=75 SIM_JITTER_MS=40 npm start
SIM_STALL_MS=150 npm start
SIM_SPIKE_MS=550 SIM_SPIKE_EVERY_MS=15000 npm start   # connection goes silent now and then
SIM_TCP_RTO=1 SIM_SPIKE_MS=300 npm start            # ...with TCP's re-send backoff
SIM_ITEMS=100 npm start                             # lots of power-ups (testing)
RTC_PORT=40000 SIM_UDP_LOSS=0.05 npm start          # WebRTC on, 5% UDP packet loss
```

### Diagnosing lag

In a match, tap the kills/ping pill (or press `N`) to open the diagnostics panel.
It shows frame times, network update gaps, server hiccups and prediction corrections,
and labels each recent spike as **device**, **network** or **server**.

The server also logs `[hiccup] game loop ran N ms late` when it falls behind. On
Render you'll find this under the service's **Logs**. Frequent hiccups mean the host
is short on CPU.

Add `?debug` to the URL to expose `window.__cr` (game state, netcode stats) in the console.

Run the tests: `npm test`

## Deploy

### VPS (recommended: fastest on Wi-Fi)

On a VPS the game also sends updates over UDP (WebRTC), which rides out Wi-Fi
blips much better than WebSocket alone. Any small Ubuntu VPS works. These steps use
Hetzner (Germany, cheap):

1. Create a server: **Ubuntu 24.04**, the cheapest **x86** type, a location close to
   your players, and **public IPv4** switched on.
2. Under **Cloud config**, paste the contents of [`deploy/cloud-init.yaml`](deploy/cloud-init.yaml).
3. Create it, and wait about 5 minutes. The game is then live at
   `https://<server-ip-with-dashes>.sslip.io`. For example, IP `116.203.12.34` becomes
   `https://116-203-12-34.sslip.io`.

What the setup does (`deploy/setup.sh`):
- installs Docker
- opens the firewall for SSH, HTTP(S) and UDP port 40000
- starts the game behind [Caddy](https://caddyserver.com), which gets a free HTTPS
  certificate automatically
- checks GitHub every 5 minutes and redeploys when the branch changes

On an existing server, run instead:

```bash
git clone --branch <branch> https://github.com/ruudwagemaker/snake.git /opt/curve-royale
sudo bash /opt/curve-royale/deploy/setup.sh
```

To use your own domain, point its DNS (an A record) at the server and put
`DOMAIN=your.domain` in `/opt/curve-royale/deploy/.env`. Then run
`deploy/update.sh --force`.

Logs: `docker compose -f /opt/curve-royale/deploy/docker-compose.yml logs -f game`.

### Render (free, WebSocket only)

Render has no UDP, so the game runs WebSocket-only there. That's fine on a good
connection. The repo includes a `render.yaml` blueprint, set to Frankfurt.

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub.
2. **New > Blueprint**, pick this repository, then **Apply**.

Every push redeploys automatically. The free plan sleeps after 15 minutes without
visitors.

### Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP/WebSocket port (default 3000) |
| `HOST` | Address to listen on (default: all) |
| `RTC_PORT` | UDP port for WebRTC. Unset means WebSocket only. Needs the optional `node-datachannel` package |
| `RTC_PUBLIC_IP` | Public IP to announce, if the server's network card has a private IP (1:1 NAT) |

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
* A client only sends "left / straight / right" for a given tick. It can't send
  positions, so there's nothing to fake. The server ignores malformed, duplicate,
  late or far-future input.

### But it feels instant (client-side prediction)

* **Your snake:** your input is applied locally right away, using the exact same rules
  (`public/shared/sim.js`) as the server. Each server update carries the state for a
  tick. The client rewinds to it and replays its inputs for later ticks
  (reconciliation). State is float32 on both sides and gap timing comes from a shared
  seed, so the replay usually matches the server exactly. When it doesn't (a late input),
  the small difference is blended out over ~100 ms instead of snapping.
* **Tick-stamped input:** every input names the server tick it's for, and is sent so it
  arrives just before that tick (lead = round trip + a small margin). The server applies
  it on exactly that tick. An input that arrives too late is dropped, and its turn just
  becomes the latest known intent. A network stall therefore can never build up a
  permanent input delay. The margin grows by a tick when an input is late and shrinks
  again after a few quiet seconds.
* **Other snakes:** while you play, they're shown at the same moment as your own
  (predicted) snake, so what you see matches what the server decides when lines
  cross. Your own snake is shown slightly ahead of the server so it feels instant;
  if others were shown in the past, you could look "clearly ahead" while really being
  nose to nose. Showing them ahead doesn't need guessing, because every update
  carries each snake's next turns that are already decided:
  - **Bots** decide their steering 8 ticks ahead. They plan from where they'll be,
    so they play just as well, and they're drawn exactly.
  - **Players'** inputs reach the server a few ticks before they're applied.
  Only what's beyond that is projected along the snake's current curve, and
  corrections glide in. While spectating, snakes are shown slightly in the past and
  interpolated. If updates stop for a moment, snakes keep moving (up to 1 s) instead
  of freezing. For experiments, `?shift=0..1`, `?turnavg=N` and `?glide=ms` in the
  URL change how other snakes are shown.
* **UDP when possible:** if the server has `RTC_PORT` set, the browser also opens a
  WebRTC data channel (unordered, no re-sends). State goes out over both UDP and
  WebSocket, and the client uses whichever copy arrives first. Inputs also go over
  both, and every UDP packet repeats the last 12 inputs. A Wi-Fi blip then only
  loses the UDP packets sent during it. Over TCP, everything would also wait for
  re-send timers, which typically doubles the stall. Ticks that UDP lost are estimated
  right away and replaced by the real data when the WebSocket copy arrives. If UDP is
  blocked, the game quietly stays on WebSocket.
* State updates are compact binary (18 bytes per snake per tick, including upcoming turns and line width). Everything else is JSON.

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
