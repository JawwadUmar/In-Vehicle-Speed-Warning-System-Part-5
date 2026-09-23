# Curve Speed Warning — Part 5

A rework of *In-Vehicle Speed Warning System for Curve Roads, Part 4*. Same idea:
warn a driver approaching a horizontal curve too fast. Different engineering.

Zero runtime dependencies. Node 18+. ES modules, so the geometry code is shared
verbatim between the server, the browser and the offline tools.

```bash
npm run build:sample          # a test road network from the surveyed alignment
npm run build:layer:sample    # offline curvature layer from that network
npm start                     # http://localhost:3000
npm test                      # 54 unit tests
npm run compare               # head-to-head of the two curve detectors
npm run replay -- --speed 45 --hz 2 --noise 1.5    # simulated drive
npm run validate -- --out logs/validation.csv      # estimator comparison
```

For a real study region, build the layer from OpenStreetMap instead:

```bash
npm run build:layer -- --bbox 22.515,75.915,22.532,75.932 --save-raw data/raw-osm.json
```

---

## What changed and why

### The warning fired against a stale distance

Part 4 computed `distanceToCurve` as the path length from `points[0]` — the
vehicle's position *at the moment the geometry was fetched* — and then reused
that frozen number until the next fetch 15 seconds later. At 80 km/h the
vehicle travels 333 m in that window, so the distance driving the 200 m warning
gate could be wrong by more than the gate itself.

Now the corridor is held client-side and the live fix is projected onto it on
every GPS update (`CorridorTracker.locate`), so the distance is always current.
Projection is onto polyline *segments*, not vertices, and is constrained to a
window around the previous chainage — without that constraint a road that
doubles back on itself snaps the match to the wrong leg, which showed up in
replay as a curve whose distance *increased* as the vehicle approached it.

### The trigger distance was a magic number

A fixed 200 m gate is too late at speed and too early in town. The alert now
fires on required deceleration:

```
a_req = (v² − v_advisory²) / (2 · (d − v·t_reaction))
```

with graded levels (advisory 0.7, warning 1.5, brake 2.8 m/s²) and separate
release thresholds so the alert cannot chatter. At 110 km/h into a 40 km/h
curve the warning now begins around 307 m, not 200 m.

Once the vehicle is committed — inside the curve, or with only reaction time
left — the braking formula diverges and would demand an emergency stop for a
5 km/h exceedance on a gentle bend. In that regime `curveUrgency` switches to
lateral-acceleration overshoot, `(V / V_advisory)²`, which is what actually
governs there.

### Two defects in the trigger logic, found by testing it

**Urgency collapsed at the commitment boundary.** The braking formula diverges
as the curve entry arrives, so a second measure — lateral-acceleration
overshoot — took over once only reaction time remained. Switching between two
measures that were never calibrated to each other produced a cliff: at R = 230 m
with a driver 20 km/h over the advisory speed, urgency read 8.27 at 50 m and
**1.39 at 48 m**, turning a BRAKE alert into an advisory at the moment the
vehicle committed to the curve. Because alerts fire only on escalation, the
system then went quiet exactly when it mattered.

The fix is to stop switching. The usable braking distance is *clamped* at 15 m,
so required deceleration rises as the curve approaches and then holds; the
lateral term becomes a floor taken with `max`, not a replacement. Urgency is now
monotone non-decreasing over every speed and radius in the operating range, and
a brake alert persists through the curve entry. Both are asserted by tests.

**The lateral floor fired at any distance.** Ungated, it alerted a driver
**1500 m** from a curve purely for being above its advisory speed — an advisory
that could never clear. It is now restricted to the committed regime, where
braking distance has genuinely run out.

**And the look-ahead was marginally too short.** Sweeping 120 speed/radius
combinations found one case where the alert was due beyond the geometry held:
at 100 km/h into a 60 m curve, the advisory falls due at 492 m against a 465 m
look-ahead. The margin is now 2.0 rather than 1.6; the sweep is a test.

### The nearest curve is not the dangerous one

Part 4 selected the curve with the smallest `distanceToCurve`. A 400 m bend
30 m ahead therefore masked a 25 m hairpin 120 m beyond it. `selectGoverningCurve`
scores every curve in the look-ahead and returns the most demanding.

### Radius estimation

Three changes, each of which is measurable in `npm run validate`:

1. **Arc-length resampling.** Part 4 fitted a circle to a fixed window of seven
   *nodes*. On the surveyed data in `data/` the point spacing is 0.93 m, so its
   window covered **6 m of road** — enough to resolve a radius of about 7 m,
   while the radii in its own database run from 18 m to 250 m. Geometry is now
   resampled to 5 m spacing, so a 40 m window is 40 m everywhere.

2. **Taubin instead of Kåsa.** The naive algebraic fit is biased towards small
   radii on short noisy arcs. Over 600 trials at 0.5 m noise, a 40 m arc of true
   radius 100 m recovers as a median 75 m under Kåsa and 99.5 m under Taubin.

3. **A curvature significance test.** An RMSE gate alone does not reject noise —
   noise fits a large circle perfectly well. A window is now accepted only if it
   turns by at least 6°, its sagitta stands clear of the measured digitising
   noise, and the radius implied by the heading change agrees with the radius the
   circle fit returned. Across 24 km of synthetic straight road with 0.9 m of
   noise this produces zero phantom curves; the RMSE-only gate produced 14 in the
   first 500 m.

   The noise estimate must be taken *before* smoothing. Smoothing drives the fit
   residual to near zero by construction, so a gate applied afterwards silently
   passes everything.

4. **An analysis window derived from the measured noise.** Sagitta grows with
   the square of the window length while noise does not, so the window sets the
   gentlest radius that can be resolved at all: a curve of radius R departs from
   its chord by W²/(8R) over a window W, and for that to clear positional noise
   sigma by the significance factor k,

       W >= sqrt(8 k sigma R)

   A fixed 40 m window therefore has a ceiling of about 67 m radius at 1 m of
   noise — everything gentler than that is being read out of noise. The window
   is now derived per corridor from the measured node noise, sized for the
   gentlest radius worth resolving (500 m, above which the IRC advisory speed
   exceeds anything a car reaches on these roads), and bounded to 60–220 m.

   The noise itself is measured straight off the original nodes, by comparing
   each with the chord joining its neighbours. The earlier estimator compared
   nodes against a *smoothed* centreline and corrected for the filter's
   attenuation, which assumes the filter averages many independent samples — it
   does not when nodes are 30 m apart and the window is 40 m. On geometry built
   with exactly 1.2 m of noise it reported 0.34 m, an under-read of 3.5x, in the
   direction that lets phantom curves through the gate.

5. **The runtime uses the layer's radii, not re-derived ones.** Curve records
   are computed once, offline, over the whole stitched chain. At drive time the
   corridor is a sliding window a few hundred metres long whose curvature
   profile is degraded at both ends, so re-analysing it made the reported radius
   depend on where the vehicle happened to be at the last corridor rebuild. Only
   the distance along the corridor is computed live, because only that has to
   be.

### Transition curves, and why the detector changed

IRC requires spiral transitions on rural highways, so a real curve is
clothoid–arc–clothoid, not tangent–arc. Two questions follow: can you tell a
transition is there, and does it matter?

**Can you tell?** From the geometry, only on the sharper curves. The spiral's
whole geometric footprint is the shift, S = L_s²/(24R):

| R | V_d | L_s | shift S | visible at 1 m noise? |
|---|---|---|---|---|
| 155 m | 65 | 74 m | 1.46 m | yes |
| 230 m | 80 | 75 m | 1.02 m | marginal |
| 360 m | 100 | 75 m | **0.65 m** | no |
| 500 m | 100 | 54 m | 0.24 m | no |

On exactly the gentle high-speed curves where it would matter most, the spiral
is below the digitising noise. In the field it is easier: superelevation is
introduced along the transition, so logging phone IMU roll against chainage
reads L_s directly off the runoff ramp — the same instrumentation already
suggested for measuring e.

**Does it matter?** Measured, not assumed. On synthetic clothoid–arc–clothoid
alignments with IRC spiral lengths, the sliding-window detector was within 1%
wherever a circular portion of 60 m or more existed. The bias only appeared as
the circular arc vanished: +13% at a 20 m arc, +29% with no circular portion at
all — the unsafe direction, and a real case on small-deflection curves where the
spirals meet.

But the measurement surfaced something worse than the bias. A spiralled curve
has a **shorter high-curvature core**, so fewer fit windows clear the
significance gate, and with 1 m of noise the curve was missed outright: a 360 m
curve with a 60 m arc was found in **0 of 12** trials. Silence, not a wrong
number — safer, but a system that misses 360 m curves at 100 km/h is not
earning its place.

So the detector was rebuilt around a continuous curvature profile
(`lib/curvatureprofile.js`). Heading is differentiated once to give κ(s); a
curve is a maximal run of sustained, same-signed curvature — which includes both
spirals, since their curvature is non-zero — and the significance test is
applied to the **whole run** rather than to isolated windows. That is what buys
the sensitivity: testing a 210 m spiral–arc–spiral curve as one object instead
of as a sequence of 100 m windows raises mid-ordinate from 3.5 m to 6.3 m
against the same noise floor.

The radius is then taken from a circle fit over the **high-curvature core**
only, because the run includes the spirals and averaging across them reports a
radius flatter than the sharpest part of the curve.

One trap found while building it: defining the core by the *maximum* curvature
let a single noise excursion own it — on a 360 m curve with 1 m noise that
excursion is far sharper than the curve, and the returned radii were 57–70% too
small. The core is now defined by the 85th percentile of |κ| within the run,
with a minimum length of 40 m.

`tools/compare-detectors.js` runs the head-to-head that decided this, and the
rule was that the new detector ships only if it improves spiralled detection
without regressing ordinary curves or raising the phantom-curve rate:

```
                              window              profile
ordinary curve, 1 m noise
  R = 155 m                   100%  −9%           100%  −3%
  R = 230 m                   100%  −14%          100%  −7%
  R = 360 m                     0%   —             92%  −16%
spiral-arc-spiral, 1 m noise
  R = 230 m, 60 m arc          58%  −8%           100%  +2%
  R = 360 m, 60 m arc            0%  —             25%  −13%
short circular arc (clean)
  R = 230 m, 20 m arc         100%  +13%          100%  +6%
phantom curves, straight road  0.00/km            0.00/km
```

On a 3 km road with six curves and 1 m noise it matched 39 of 48 true curves
against the window detector's 32, at −4% median error against −6%.

The one place it loses is **very short chains**: it differentiates over a
window, so on a 47–83 m stub there is no usable interior and it returns nothing
where the window detector still finds curves. `--detector auto`, the default,
therefore uses the profile detector on chains of 150 m or more and the window
detector below that. The build reports which was used, and flags curves whose
near-circular core is under 45 m, since those may read about 5% flat.

### Advisory speed, and the side-friction factor

`advisorySpeedKmh` solves

```
V_a = √( 127 · R · (e + f(V_a)) )
```

by bisection. Bisection rather than fixed-point iteration: the obvious
iteration has |dV′/dV| > 1 where a speed-dependent friction table is steepest,
and above R ≈ 700 m it entered a limit cycle — 107.2 km/h returned for
R = 1000 m against a true root of 113.9, with 85 radii returning a *lower*
advisory for a *larger* curve. A test now asserts monotonicity in R from 20 to
2000 m under both friction models.

**f = 0.15, per IRC:73 / IRC:38.** The system is for Indian rural highways and
the rest of the model — the superelevation procedure, the e_max cap, the
restricted-speed formula — is IRC-derived, so the friction factor is too.
Mixing an AASHTO curve into an otherwise IRC model is a mixed-standard result
that is hard to defend, and IRC's own restricted speed √(127R(e_max + 0.15))
assumes exactly this constant. IRC specifies 0.15 as the *maximum* design side
friction, so the advisory speed is the highest speed at which friction demand
stays within the design limit. A test asserts that on a capped curve the
advisory speed equals IRC's restricted speed exactly.

With f constant the equation has the closed form V = √(127R(e + 0.15)); the
general solver is kept so the sensitivity run shares one code path.

**AASHTO's speed-dependent curve** (0.17 at 30 km/h falling to 0.09 at 120)
remains available as `frictionModel: 'aashto'`, for sensitivity only. The two
agree within 2 km/h below R = 230 m and diverge on gentle curves, where AASHTO
is the more conservative:

| R | IRC f = 0.15 | AASHTO f(V) |
|---|---|---|
| 155 m | 65.8 km/h | 65.0 km/h |
| 230 m | 80.2 km/h | 78.3 km/h |
| 360 m | 96.1 km/h | 91.0 km/h |
| 500 m | 109.1 km/h | 100.0 km/h |

`npm run validate` reports this comparison alongside the superelevation
envelope, so both assumptions appear as stated sensitivities rather than buried
choices.

One framing point worth keeping in the paper: f ≈ 0.15 is a design *comfort*
value, not the friction limit. At the advisory speed the actual demand is
0.12–0.16 against roughly 0.70 available on dry pavement — a margin of about
5×. That is why this is a design-consistency advisory rather than a
loss-of-control threshold, and why exceeding it is routine rather than
dangerous.

The Part 4 formula is retained as `advisorySpeedPart4` so the two can be
compared in the UI and in the logs.

### Superelevation

This went through three positions before settling.

Part 4 assumed **e = 7% everywhere**. On an unbanked curve that advises about
20% too fast — the unsafe direction.

The first revision assumed **e = 0 everywhere**. Never advises too fast, but the
advisory then sits at 0.13–0.16 g, against a dry-pavement limit near 0.75 g.
Compared against typical free-flow speeds on two-lane rural curves, the
advisory is exceeded by 24–27 km/h in the 90–230 m radius band — so the system
would alert on nearly every curve, for nearly every driver, and be switched off.
Safe, and useless.

What ships is **design-implied e, derived per curve from the IRC procedure**
(`lib/superelevation.js`), resolved at build time and stored in the curve
record:

```
1.  e = Vd² / (225 R)
2.  cap at e_max (7% plain and rolling, 10% hill roads)
3.  if capped, check f = Vd²/(127R) − e_max; if f > 0.15 the curve is
    substandard and IRC restricts the speed to √(127R(e_max + 0.15))
```

The 225 is not arbitrary: equilibrium gives `e + f = V²/(127R)`, and IRC banks
the curve to fully counteract centrifugal force at **75% of the design speed**
with f = 0, so e = (0.75Vd)²/(127R) = Vd²/(226R). Three quarters rather than the
full speed because over-banking makes slow vehicles slide toward the inner edge.

**The design speed does not have to be known precisely.** Step 1 exceeds the cap
whenever R < Vd²/15.75 — at the lowest plausible design speed, every curve below
**268 m radius**. Across the range where warnings actually fire, every plausible
design speed returns the same e = e_max. `designSpeedSensitivity` reports where
a given corridor sits, and the build prints it:

```
Design-speed sensitivity (65 / 80 / 100 km/h):
  unaffected by the assumption  5 of 5 curves
  affected                      none — the cap governs every detected curve,
                                so the design-speed assumption does not enter the result
```

That turns an assumption into a bounded one, which is a far stronger position
than asserting 7% outright — and on the curves that matter it is the same number.

**Measured values always win.** `--measured-superelevation <csv>`
(latitude, longitude, e as fraction or percent) is matched to curves by
proximity, so a survey survives a layer rebuild even though curve ids change.
A measured *zero* is honoured as a measurement — an unbanked curve is exactly
what must not be silently replaced by the design assumption. A phone
inclinometer at the apex resolves ~0.3°, which is ±0.5% in e, four times better
than the ±2% needed to get the advisory within 4 km/h.

Design speed enters only at **build time**, and is a property of the road, not
the curve: `--road-class`, `--terrain` and `--design-basis` (default `minimum`,
the conservative branch) select it from the IRC table. The vehicle never sees
it. Feeding the *driver's current speed* into the formula instead would make the
assumed banking rise with the driver's speed — the advisory would chase the
driver upward and essentially never fire. The rule is that nothing on the
vehicle side of the calculation may enter the road model.

`npm run validate` reports the advisory-speed envelope between e = 0 and
design-implied per radius band. That width is exactly what a superelevation
survey would close.

### Map matching and the look-ahead corridor

- Matching scores true perpendicular distance to segments with an explicit
  metres-per-degree heading weight, and rejects ways running the wrong way.
- The corridor follows road connectivity through shared node ids. OSM splits
  ways at every junction and tag change; Part 4 stopped at the first split, so
  the look-ahead frequently ended a hundred metres out and any curve past the
  split was invisible. In the test network, six split ways are correctly
  restitched into one 211-point chain.
- Look-ahead length scales with speed rather than being fixed at 500 m.

### Overpass is a build-time tool, not a driving-time one

Overpass fair use allows a couple of requests per minute. Part 4 polled it every
15 s with a cache key rounded to ~11 m, so almost every request missed the cache;
sustained driving would earn a 429 within minutes, and it cannot work in a tunnel
or a dead zone at all.

Geometry for the study region is now extracted, stitched, smoothed and analysed
once by `tools/build-curve-layer.js` into `data/curve-layer.json`, indexed on a
uniform grid. At run time the work is map matching plus a lookup: no network, and
deterministic — two replays of one GPS trace produce identical warnings, which is
what makes a result reportable.

The live Overpass path remains as a fallback, now with an identifying
User-Agent, request timeouts, exponential backoff that honours `Retry-After`,
endpoint rotation and a bounded LRU cache. Set `OVERPASS=off` to disable it.

### One warning source, not two

Part 4 fell back to the surveyed point table whenever the live fetch failed, and
that fallback had defects of its own: it became permanently unreachable once any
dynamic fetch had succeeded, and it warned on whichever surveyed point was
*nearest* rather than which curve was *ahead*, so it would alert about a curve
the vehicle had just left.

Rather than repair it, it is gone. The offline curvature layer already covers
the whole study region with no network, which was the fallback's original job,
and the fallback was structurally the weaker method: no corridor, so
straight-line distance instead of distance along the road, and no way to confirm
which road the vehicle was on. Issuing a safety warning from the least reliable
and least exercised path is the wrong trade.

When no corridor matches, the app now says so — "off the mapped road network" or
"road service unavailable" — and stays silent rather than guessing.

`data/surveyed-points.json` remains, as the reference dataset for
`tools/validate.js`. It is a validation input, not a warning source: its radius
column correlates with its own coordinates at only r = 0.69 and appears to
saturate near 230 m, which is fine to measure against and not fine to advise
from.

### Service worker

Part 4's worker precached `./images/speedometer.png`, which does not exist in the
repository. `cache.addAll` rejects atomically, so install always failed, the
worker never activated, and nothing was ever cached — the PWA was not offline
capable. Its fetch handler was also cache-first for *every* request including
`/api/road-ahead`, so had it worked it would have served stale road geometry.

Now: shell entries are cached individually so one missing file cannot fail the
install, `/api/road-ahead` is network-only, and the curve layer is
stale-while-revalidate.

### Smaller fixes

- `navigator.getWakeLock()` is an abandoned experiment that has never shipped;
  the screen slept mid-drive. Replaced with `navigator.wakeLock.request('screen')`
  and re-acquisition on `visibilitychange`.
- `coords.speed` is null on desktop and on many handsets when stationary, so the
  readout sat at 0 and no warning could fire in bench testing. `MotionEstimator`
  falls back to differentiating positions, smooths both speed and heading, gates
  on `coords.accuracy`, and rejects implausible jumps.
- Overlapping corridor requests are sequence-guarded and abortable; a slow reply
  can no longer overwrite fresher geometry.
- Part 4's static fallback has been removed from the warning path entirely; see
  *One warning source, not two* below.
- Part 4's detector rejected `radius < 15 m` while its own database contained
  10.6 m and 13.8 m radii.
- Per-client rate limiting, so `/api/road-ahead` is not an open Overpass proxy.
- Alerts are audible and spoken, not text-only, and the page background carries
  the alert level.

---

## Running on the road

Geolocation requires a secure context, so over plain HTTP the app only works on
`localhost` — Part 4 could not be tested on a handset at all. Provide a
certificate:

```bash
TLS_CERT=cert.pem TLS_KEY=key.pem npm start
```

A self-signed certificate trusted on the test device is sufficient.

---

## Validation

`npm run validate` compares both estimators against the surveyed radii and
reports error stratified by radius band, because aggregate error hides the thing
that matters: a 100 m error on a 250 m curve costs a few km/h of advisory speed,
while the same error on a 30 m curve does not.

On the supplied data, in the safety-critical band below 40 m radius, median
absolute percentage error falls from 35% to 24% and the median advisory-speed
error from +3.0 to +1.5 km/h.

`--mode layer` runs the same comparison against a curve layer built from real
OSM, which is the number to report in a paper: it measures what OSM digitising
quality costs, rather than what the estimator costs.

### A caveat about the supplied ground truth

`data/surveyed-points.json` (Part 4's `database.json`) is not a continuous drive
trace. It contains jumps of 563 m, 284 m and 177 m among its first 19 rows; only
rows 18–210 form a contiguous alignment, and that alignment is 182 m long at
0.93 m point spacing. Treating the whole table as one polyline — as the sample
generator originally did — fabricates half a kilometre of road that does not
exist. All the tools now split on gaps above 40 m.

More importantly, the `radius` column cannot be reproduced from the coordinates
in the same file. The coordinates sit within 0.21 m of their own smoothed
centreline, which is clean enough for a 100 m window to resolve radii up to
about 2000 m — yet the revised estimator correlates with the column at only
r = 0.69, agreeing closely below 80 m and diverging above it, where the column
appears to saturate near 230 m. Whatever produced that column, it was not local
circle fitting on these coordinates. It is worth establishing its provenance
before using it as ground truth in a paper.

---

## Layout

```
lib/geo.js          geodesy, local frames, polyline projection, gap splitting
lib/curvature.js    resampling, SG smoothing, Taubin/Kasa fits, window detector
lib/curvatureprofile.js  kappa(s) curve detector (default) and the dispatcher
lib/superelevation.js    IRC superelevation, design speeds, measured overrides
lib/safespeed.js    friction model, advisory speed, deceleration, alert levels
lib/roadgraph.js    map matching, corridor stitching across way splits
lib/curvelayer.js   offline layer format and grid index
lib/pipeline.js     corridor payload, CorridorTracker, MotionEstimator
lib/overpass.js     Overpass client with backoff, timeouts, LRU cache

server.js           static server + /api/road-ahead + /api/health

public/             the in-vehicle PWA (imports lib/ directly)

tools/make-sample-network.js     test network from the surveyed alignment
tools/build-curve-layer.js       OSM -> offline curvature layer
tools/replay.js                  GPX/CSV/synthetic replay -> trip CSV
tools/validate.js                estimator comparison and diagnostics
tools/compare-detectors.js       head-to-head of the two curve detectors
```

The in-vehicle logger and the replay harness emit the same CSV schema, so field
logs and simulated runs are directly comparable.

---

## Review findings, fixed

A three-way review of this codebase found 22 defects. The ones worth recording,
because each is a trap the next version could fall into again:

- **The phantom-curve gate collapsed on real OSM geometry.** Digitising noise was
  measured on the *resampled* polyline. Resampling interpolates along the straight
  lines between nodes, so the residual shrinks as node spacing grows and sparse,
  noisy geometry reads as pristine. At 25 m node spacing — ordinary for OSM — with
  0.8 m of noise, the estimate came out ten times too low and roughly **nine
  phantom curves per kilometre** passed the gate. It only ever tested clean
  because both straight-road tests fed points at exactly 5 m spacing, the one
  spacing at which resampling does nothing. Noise is now measured against the
  original nodes, with a 1 m floor (`--min-noise` to change it) because on
  sparsely noded geometry the residual genuinely cannot reveal the noise.
- **The advisory-speed solver did not converge.** The fixed-point iteration has
  |dV'/dV| > 1 where the friction table is steepest, so above about R = 700 m it
  entered a limit cycle: 107.2 km/h returned for R = 1000 m against a true root of
  113.9, and 85 radii returned a *lower* advisory speed for a *larger* curve.
  Replaced with bisection, which the monotonicity of the balance function makes
  exact.
- **A GPS fix rejected by the accuracy gate still became the baseline** for the
  next one. A single 250 m outlier turned a steady 50 km/h into 105 km/h and
  flipped the heading by 285°, which then built the corridor in the wrong
  direction of travel.
- **The continuity window was wide enough to contain the opposite carriageway.**
  A fixed 400 m forward window let one sideways excursion latch the match onto
  the returning leg of a hairpin, after which chainage ran backwards while the
  vehicle moved forward. The window is now derived from elapsed time.
- **Alerts fired on de-escalation.** One correctly executed braking manoeuvre
  produced three separate alerts — brake, then warning, then advisory — so the
  driver was beeped at for doing the right thing and the last thing they heard
  entering the curve was the mildest alert. Sound and speech now fire only on
  escalation, and the per-curve dedupe is no longer reset every time the alert
  clears.
- **"road ends ahead" was inverted**, testing `truncated === false` (meaning the
  corridor is full length) rather than `atNetworkEnd`. It appeared on ordinary
  continuous roads and stayed silent in the one case that mattered.
- **A hung corridor request disabled warnings permanently**, silently: `inFlight`
  blocked every later request and the fetch had no deadline. Now
  time-limited.
- **Untagged OSM ways were invisible at run time.** The build stored `highway:
  'unknown'`, and the runtime rejected that literal — so those roads were indexed,
  returned by the spatial lookup, and then dropped, and no corridor could ever be
  built on them.
- **A malformed percent-escape killed the server process.** `GET /%` threw inside
  an async handler, became an unhandled rejection, and took every subsequent
  request with it.
- **The rate limiter was fully bypassable**: it cleared the whole map when it
  grew, wiping the counters of clients currently over the limit.
- **`Math.min(...coordinates)` blew the call stack** on any realistic region —
  after the Overpass fetch and the entire curvature analysis had completed, so the
  whole build was lost.
- **The GPX parser silently dropped track points** when a file mixed self-closing
  and closed `<trkpt>` tags, and mixed two epochs when some points had no
  `<time>`, which made every derived speed zero so no alert could fire.
- **The service worker served the shell cache-first with no revalidation**, so a
  corrected safety module would never reach an installed client, and its offline
  fallback returned `index.html` for failed *module* requests — the browser
  rejects those on MIME type, leaving a page with no handlers and no error.
- **`[hidden]` did not hide.** `dl > div { display: contents }` is author-origin
  and overrode the user agent's `[hidden] { display: none }`, so the deprecated
  Part 4 advisory speed sat on screen permanently, next to the real one,
  regardless of the checkbox.

Regression tests cover the first four, plus the sparse-geometry noise case that
the original tests structurally could not catch.

## Alert rate: the feasibility constraint

The trigger logic is sound, but soundness is not sufficiency. Measured against
a Lamm-type operating-speed model for two-lane rural roads, with IRC friction
and design-implied superelevation:

| R | V_advisory | V85 driver | exceedance | alert | warning time |
|---|---|---|---|---|---|
| 90 m | 50 | 68 km/h | +18 | advisory | 7.4 s |
| 155 m | 66 | 83 km/h | +17 | advisory | 7.1 s |
| 230 m | 80 | 89 km/h | +9 | advisory | 4.5 s |
| 360 m | 96 | 94 km/h | −2 | silent | — |
| 600 m | 118 | 97 km/h | −20 | silent | — |

**Seven of ten curves alert for a driver behaving normally** (three of ten for a
cautious one, nine of ten for an aggressive one). Design-implied superelevation
improved this from nine of ten under the earlier e = 0 assumption, but did not
solve it.

Making the advisory tier visual-only does not help much either — the three tiers
are separated by only 2–4 km/h of approach speed, because they grade *urgency*
(how late you are) rather than *exceedance*. Audible alerts would fall only from
seven to six.

The cause is not the trigger. It is that IRC design advisory speeds sit 9–19 km/h
below observed operating speeds on these radii, and no tuning of the trigger
changes that. Warning times of 4.5–7.7 s are ample, so the system is not
mistimed; it is measuring design consistency, and on these roads design
consistency is routinely absent.

Two honest ways forward, and they are not exclusive:

- **Report it as a result.** The alert rate *is* a measurement of how far
  operating speeds exceed design-consistent speeds on the study corridor. That
  is publishable, and more interesting than a warning system that happens to
  stay quiet.
- **Add an empirically calibrated trigger for the field trial**, keyed to the
  observed speed distribution for each curve rather than to the design advisory,
  with the IRC advisory retained as the displayed reference. That gives a
  two-arm comparison and an alert rate a driver will tolerate for long enough to
  measure a speed reduction.

## What the end-to-end test measures

`tools/make-test-road.js` builds a two-lane rural highway to IRC — six curves
spanning R = 90 to 500 m, bracketing the ruling and absolute minima for 80 km/h,
with clothoid transitions on each — then degrades it to OSM-like geometry:
irregular node spacing and Gaussian positional noise. `tools/check-test-road.js`
matches what the pipeline found against what was designed. A second design
(`--design hill`) is a ghat section of short sharp curves, and `--design
straight` is a tangent for counting phantom curves.

Over 5 seeds x 3 noise levels on each design (60 designed curves per road type):

| | 0.6 m noise | 1.2 m | 2.0 m |
|---|---|---|---|
| rural, found | 30/30 | 30/30 | 30/30 |
| rural, median radius error | 3% | 5% | 7% |
| hill, found | 30/30 | 30/30 | 30/30 |
| hill, median radius error | 2% | 4% | 5% |
| phantom curves, 40 km of straight road | 0 | 0 | 0 |

Accuracy is not uniform across radii, and this is the number to quote. Over 60
noise realisations at 30 m node spacing and 1.2 m noise, the 5th–95th percentile
band on the reported radius is:

| designed R | reported band | IRC advisory across that band |
|---|---|---|
| 90 m | 85–93 m | 49–51 km/h |
| 155 m | 148–163 m | 64–68 km/h |
| 230 m | 214–249 m | 78–84 km/h |
| 340 m | 256–391 m | 85–103 km/h |
| 500 m | 254–588 m | 85–127 km/h |

The median is unbiased at every radius; the scatter grows as the curve flattens,
because a gentle curve's mid-ordinate over the analysis window is only a small
multiple of the digitising noise. That is the right way round: the advisory
speed is precise on the curves where it actually constrains a driver, and
imprecise on curves whose advisory sits above the speeds these roads carry.

A replay over the rural road (`npm run replay -- --layer data/test-road-layer.json
--synthetic --speed V`) gives the alert timeline: silent at 50 km/h, one curve at
65, two at 80, all five sub-advisory curves at 100, each escalating advisory →
warning → brake in order.

## Before the first field drive

The code is validated in simulation, not on a road. Everything below has to
happen before a drive produces data worth analysing.

1. **Build a curve layer for your actual corridor.** `data/curve-layer.json` as
   shipped is built from the synthetic sample network — it is a placeholder, and
   driving against it will match nothing. Fetch the corridor from Overpass
   (`npm run build:layer -- --bbox s,w,n,e --road-class SH --terrain rolling`)
   on a machine with internet access, and keep the bbox generous: the layer is
   the only geometry source at drive time, so anything outside it is silent
   road.

2. **Read the resolvable-radius line the build prints.** It reports the measured
   node noise for your corridor and the gentlest radius that geometry can
   support. If it comes back at, say, 250 m, then every curve flatter than that
   on your route is being reported with wide uncertainty, and you should say so
   in the write-up rather than discover it in the data.

3. **Check the detected curves against the field.** Open the layer's apex
   coordinates on satellite imagery and confirm each one is a real curve, and
   that no curve on the route is missing. This is a ten-minute job on a 20 km
   corridor and it is the only check that catches a mis-tagged or mis-traced
   way.

4. **Serve over HTTPS.** The browser Geolocation API and the Wake Lock API both
   require a secure context, so `http://` will fail on the phone with no useful
   error. `server.js` takes `TLS_KEY` and `TLS_CERT`; a self-signed certificate
   is fine for a trial, with the certificate trusted on the test phone.

5. **Drive the route once with the display off and the logger on**, before any
   driver sees a warning. That baseline trip tells you the false-alarm rate and
   the match rate on real GPS, and `tools/replay.js` will re-run the same log
   against changed settings afterwards without another drive.

6. **Decide the superelevation policy explicitly.** The default is
   design-implied from IRC, which assumes each curve was built to standard. If
   you have measured cross-slope for any curve, put it in the measured table —
   a curve that is flatter than IRC implies is the one case where the advisory
   speed is optimistic rather than conservative.

7. **Treat it as an instrument, not a safety device.** The advisory is a
   design-consistency speed, roughly a factor below the dry-friction limit, so
   it is a research stimulus — not a threshold at which a car would leave the
   road. Brief the driver accordingly, and do not let the display be the reason
   anyone drives a curve they would not otherwise have driven.

## Still open

- Matching is greedy per fix. An HMM/Viterbi matcher (Newson & Krumm) would be
  more robust at junctions and in urban canyons; the continuity window here is a
  cheap approximation of it.
- Superelevation is not available from OSM. Until curves carry a surveyed value
  the advisory speed assumes an unbanked curve, which is safe but conservative
  on well-banked roads.
- The advisory model is point-mass. It says nothing about vehicle class, load,
  rollover threshold, or a wet surface.
- No formal false-alarm rate on real roads yet. The replay harness and the trip
  logger exist to produce one; that measurement is the next piece of work.

This is a research prototype. Validate the map matching and the curve fits
against surveyed geometry before any safety-critical use.
