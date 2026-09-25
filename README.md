# Rookfall — a browser RTS

A real-time strategy game in the classic mold: low-poly 3D, workers and gold, barracks, catapults,
two ages and a castle to besiege. Skirmish against bots runs entirely in the browser — no server,
no internet. To play with people there are invite-link rooms and ranked 1v1.

![Rookfall](docs/screen.jpg)

## Modes

|  |  |
|---|---|
| ⚔️ **Vs AI** | skirmish for up to 6 players, three bot difficulties, 7 maps (random one included), match speed 1×–5× |
| 🌐 **Multiplayer** | room by code or invite link, public or private, chat, bots in free slots |
| 🏆 **Ranked** | 1v1 on a symmetric random map, Glicko-2 from 1500; if no opponent turns up in 3 minutes you get a practice match against a bot |
| 🎞️ **Replays** | every match is recorded and can be replayed with seeking |
| 👤 **Account** | optional, e-mail and password: the ladder rating you earned as a guest moves in and follows you to any device; the nickname can be changed as often as you like |

## Rules in short

Win by destroying every enemy castle. You start with a castle, 4 workers and 300 gold.

**Economy.** Workers mine gold from veins and carry it back to the castle — a loaded worker walks
30 % slower. Any number of them can dig the same vein; what limits a crowded deposit is the walk home,
not a queue for a place at the face. They also build and repair, and with no orders they find work on
their own. A mine gives passive income: up to three workers inside, no walking, out of harm's way.
A building you take apart pays back 60 % of what it cost.

**Building.** House (+5 population), barracks, forge (rams and upgrades), watchtower, fence and mine. Four fence cells
in a straight line raise a gatehouse over the middle of the run: your own troops walk through the door, everyone
else meets a wall and has to break it down.
Every building has three construction stages, so it visibly grows — and a hit on the site knocks
its progress back.

**The triangle.** Soldiers cut down archers and cavalry, archers and cavalry punch through
siege engines, siege tears apart buildings and heavy infantry. Each branch has its own ability —
shield stance, volley, incendiary shot; the castle calls up three free militia every 2 minutes.

**Siege.** The forge builds a battering ram from the first age: it wrecks masonry twice as fast as a
sword does and shrugs swords off, but it cannot swing at a man at all — walk it in behind the line, and
keep it away from archers and towers, which hit it for ×1.5. The second age adds the catapult, which
throws over a distance.

**The second age** (1000 gold, needs a forge) turns every building to stone and toughens it — the wooden
fence in particular goes from flimsy to something worth hiding behind — unlocks the catapult and cavalry,
and opens the higher upgrade levels.

## Controls

|  |  |
|---|---|
| LMB, drag box | select; Shift adds to the selection |
| RMB | smart order: move, attack, gather, enter a mine or tower |
| Hold RMB or middle button | pan the camera; wheel zooms, `Q`/`E` rotate, `WASD` and arrows scroll |
| `A` `S` `H` `P` | attack-move, stop, hold position, patrol |
| `B` | build menu: `C` castle, `H` house, `B` barracks, `F` forge, `T` tower, `L` fence, `M` mine |
| `W` `S` `R` `V` `T` `C` | train worker, soldier, archer, cavalry, ram, catapult |
| `D` `X` `I` | ability, dismantle a building, advance to the second age |
| `F1` `F2` | select the whole army / next idle worker |
| ⛶ | fullscreen |
| Touch | one finger is LMB, two are RMB: tap selects (bare ground drops the selection), a two-finger tap gives the order, holding both queues it · drag moves the camera, hold then drag draws a box · pinch zooms about the fingers (on a phone, close enough to tap one unit), twist rotates |

Hotkeys are bound to the physical key, so on a Russian layout "Ф" still means `A`. All of them are
rebindable in the settings.

## Running it locally

Node 20+ and pnpm.

```bash
pnpm install
pnpm assets   # build the 3D models into public/models — once after cloning
pnpm dev      # server :8080 + client :5173, open http://localhost:5173
```

One command brings up everything: Vite proxies `/ws` and `/api` to the game server. A skirmish
against bots needs no server at all, but the same process hosts lobbies, ranked and replays.

Production build — `pnpm build && pnpm start`: a single Node process serves the client, the API and
the WebSocket on :8080. Server settings: `PORT` (8080), `DATA_DIR` (`./data` — replays, ratings and accounts),
`GIT_SHA` (build version, reported by `/api/health`).

## Further reading

- [docs/DESIGN.md](docs/DESIGN.md) — how it works inside: deterministic lockstep, the package layout, every gameplay decision and the repo's commands (in Russian).
- [DEPLOY.md](DEPLOY.md) — deployment: Docker, nginx, ports, updates and rollback (in Russian).
- [PRD.md](PRD.md) — the original spec (in Russian).

Building models come from the [Quaternius Ultimate Fantasy RTS](https://quaternius.com) pack (CC0);
the units are built by our own Blender scripts.
