'use strict';

import { CorridorTracker, MotionEstimator } from '/lib/pipeline.js';
import {
  advisorySpeedPart4, classifyAlert, requiredLookAheadMetres, selectGoverningCurve,
  sideFriction, alertLabel
} from '/lib/safespeed.js';

const settings = {
  frictionModel: 'irc',   // IRC:73/38 f = 0.15; see lib/safespeed.js
  // 'record'  - use what the curve carries (measured, else design-implied per IRC)
  // 'zero'    - override everything with e = 0, the conservative lower bound
  // 'seven'   - override with e = 7%, the Part 4 assumption, for comparison
  superelevationMode: 'record',
  reactionSeconds: 1.2,
  audioEnabled: true,
  speechEnabled: true,
  showPart4Comparison: false
};

const state = {
  watchId: null,
  wakeLock: null,
  tracker: new CorridorTracker(),
  motion: new MotionEstimator(),
  fetchSequence: 0,
  inFlight: null,
  lastFetchAt: 0,
  lastFetchFailedAt: 0,
  lastFetchFailureReason: null,
  alertLevel: 'none',
  alertSince: 0,
  announcedFor: null,
  statusIsStale: false,
  log: [],
  audioContext: null
};

const MIN_ALERT_MS = 2000;
const MIN_FETCH_INTERVAL_MS = 4000;
const FETCH_BACKOFF_MS = 20000;
// A corridor request that never settles must not wedge the app: `inFlight`
// blocks every later request, so one hung fetch on marginal cellular used to
// disable warnings silently for the rest of the drive.
const FETCH_TIMEOUT_MS = 8000;

const dom = {};
for (const id of ['start', 'location', 'currentspeed', 'safespeed', 'radius', 'datasource',
  'warning', 'distance', 'requireddecel', 'accuracy', 'part4', 'part4row', 'logcount',
  'download', 'reset', 'frictionmodel', 'superelevation', 'reaction', 'audio', 'speech',
  'comparison', 'status', 'superelevationreadout']) {
  dom[id] = document.getElementById(id);
}

/* ------------------------------------------------------------------ controls */

dom.start.addEventListener('click', () => (state.watchId ? stop() : start()));
dom.download.addEventListener('click', downloadLog);
dom.reset.addEventListener('click', () => { state.log = []; dom.logcount.textContent = '0'; });
dom.frictionmodel.addEventListener('change', event => { settings.frictionModel = event.target.value; });
dom.superelevation.addEventListener('change', event => { settings.superelevationMode = event.target.value; });
dom.reaction.addEventListener('change', event => { settings.reactionSeconds = Number(event.target.value); });
dom.audio.addEventListener('change', event => { settings.audioEnabled = event.target.checked; });
dom.speech.addEventListener('change', event => { settings.speechEnabled = event.target.checked; });
dom.comparison.addEventListener('change', event => {
  settings.showPart4Comparison = event.target.checked;
  dom.part4row.hidden = !event.target.checked;
});

function start() {
  if (!navigator.geolocation) {
    setStatus('This browser has no Geolocation API.', 'error');
    return;
  }
  if (!window.isSecureContext) {
    setStatus('Geolocation needs HTTPS or localhost. See the README for running with TLS.', 'error');
    return;
  }
  // The audio context must be created inside a user gesture to be allowed to play.
  if (!state.audioContext && window.AudioContext) state.audioContext = new AudioContext();
  if (state.audioContext?.state === 'suspended') state.audioContext.resume();

  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000
  });
  requestWakeLock();
  dom.start.textContent = 'Stop';
  dom.start.classList.add('active');
  setStatus('Waiting for a GPS fix…', 'info');
}

function stop() {
  navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  releaseWakeLock();
  state.inFlight?.abort();
  state.inFlight = null;
  // Invalidate any reply already in flight, so a late response cannot install a
  // corridor after the driver has stopped and have it reused on the next start.
  state.fetchSequence += 1;
  state.tracker.clear();
  state.motion = new MotionEstimator();
  state.alertLevel = 'none';
  state.lastFetchFailureReason = null;
  state.lastFetchFailedAt = 0;
  dom.start.textContent = 'Start';
  dom.start.classList.remove('active');
  resetReadout();
  setStatus('Stopped.', 'info');
}

function resetReadout() {
  dom.currentspeed.textContent = '0 km/h';
  dom.location.textContent = '—';
  dom.accuracy.textContent = '—';
  dom.radius.textContent = '—';
  dom.safespeed.textContent = '—';
  dom.part4.textContent = '—';
  dom.distance.textContent = '—';
  dom.requireddecel.textContent = '—';
  if (dom.superelevationreadout) dom.superelevationreadout.textContent = '—';
  dom.datasource.textContent = 'Idle';
  setAlert({ level: 'none', label: '' }, null);
}

/* -------------------------------------------------------------- wake lock */

async function requestWakeLock() {
  // Part 4 called navigator.getWakeLock(), an abandoned experiment that has
  // never existed in a shipping browser, so the screen slept mid-drive.
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch {
    /* denied or unsupported; not fatal */
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.watchId && !state.wakeLock) requestWakeLock();
});

/* ------------------------------------------------------------- main loop */

function onPositionError(error) {
  setStatus(`Geolocation error: ${error.message}`, 'error');
  state.statusIsStale = true;
}

function onPosition(position) {
  const timestamp = position.timestamp || Date.now();
  const motion = state.motion.update(position.coords, timestamp);

  dom.currentspeed.textContent = `${motion.speedKmh.toFixed(0)} km/h`;
  dom.location.textContent =
    `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`;
  dom.accuracy.textContent = motion.usable
    ? `±${Math.round(motion.accuracy)} m`
    : `±${Math.round(motion.accuracy)} m (degraded)`;

  const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
  const lookAhead = requiredLookAheadMetres(motion.speedKmh);

  if (state.tracker.needsRefresh(point, lookAhead, timestamp)) {
    refreshCorridor(point, motion.headingDegrees, lookAhead);
  }

  const located = state.tracker.locate(point, timestamp);
  let candidates = [];
  let source = 'No road geometry';

  if (located && located.valid) {
    candidates = located.curvesAhead;
    source = `${state.tracker.corridor.source} · matched ${located.offset.toFixed(0)} m off centreline`;
    // `truncated` only means "shorter than requested"; the flag that means the
    // mapped road actually runs out is `atNetworkEnd`. Testing truncated ===
    // false appended this on ordinary continuous roads and stayed silent in the
    // one case that matters.
    if (state.tracker.corridor.atNetworkEnd && located.remainingMetres < lookAhead * 0.5) {
      source += ' · mapped road ends ahead';
    }
    if (state.statusIsStale) {
      setStatus('Tracking.', 'info');
      state.statusIsStale = false;
    }
  } else {
    // No usable match. The app says so rather than guessing: the surveyed point
    // table was removed from the warning path because it has no corridor (so
    // only straight-line distance), cannot confirm which road you are on, and
    // its radius column is of unestablished provenance. It remains a reference
    // dataset for tools/validate.js.
    const isBackingOff = state.lastFetchFailedAt && Date.now() - state.lastFetchFailedAt < FETCH_BACKOFF_MS;
    if (isBackingOff) {
      const reason = state.lastFetchFailureReason ? ` (${state.lastFetchFailureReason})` : '';
      source = `Road service unavailable${reason} — no warnings`;
    } else if (state.inFlight) {
      source = 'Fetching road geometry… — no warnings';
    } else if (state.lastFetchFailureReason) {
      source = `Road geometry unavailable (${state.lastFetchFailureReason}) — no warnings`;
    } else {
      source = 'Off the mapped road network — no warnings';
    }
  }

  // The mode decides whether the curve's own superelevation is honoured or
  // overridden, so the driver can see the design-implied and conservative
  // bounds side by side on the same curve.
  const override = settings.superelevationMode === 'zero' ? 0
    : settings.superelevationMode === 'seven' ? 0.07
    : null;
  const adjusted = override === null
    ? candidates
    : candidates.map(curve => ({ ...curve, superelevation: override, superelevationSource: 'override' }));

  const governing = selectGoverningCurve(adjusted, motion.speedKmh, {
    frictionModel: settings.frictionModel,
    superelevation: 0,
    reactionSeconds: settings.reactionSeconds
  });

  render(governing, source, motion, position, timestamp);
}

function render(governing, source, motion, position, timestamp) {
  dom.datasource.textContent = source;

  if (!governing) {
    dom.radius.textContent = '—';
    dom.safespeed.textContent = '—';
    dom.part4.textContent = '—';
    dom.distance.textContent = '—';
    dom.requireddecel.textContent = '—';
    const displayed = setAlert(classifyAlert(0, state.alertLevel), null);
    appendLog(position, motion, null, displayed, timestamp);
    return;
  }

  const advisory = governing.advisorySpeedKmh;
  dom.radius.textContent = `${governing.radius.toFixed(0)} m ${governing.direction ? `(${governing.direction})` : ''}`;
  if (dom.superelevationreadout) {
    const value = Number.isFinite(governing.superelevation) ? governing.superelevation : 0;
    const label = { measured: 'measured', 'design-implied': 'IRC design', 'assumed-zero': 'assumed 0%', override: 'override' };
    dom.superelevationreadout.textContent =
      `${(100 * value).toFixed(1)}% (${label[governing.superelevationSource] || 'assumed 0%'})`;
  }
  dom.safespeed.textContent = `${advisory.toFixed(0)} km/h`;
  dom.part4.textContent = `${advisorySpeedPart4(governing.radius).toFixed(0)} km/h`;
  dom.distance.textContent = governing.inCurve
    ? `in the curve, ${Math.max(0, governing.distanceToExit || 0).toFixed(0)} m to exit`
    : `${governing.distanceAhead.toFixed(0)} m`;
  dom.requireddecel.textContent = Number.isFinite(governing.requiredDeceleration)
    ? `${governing.requiredDeceleration.toFixed(2)} m/s²`
    : 'beyond braking';

  const alert = classifyAlert(governing.requiredDeceleration, state.alertLevel);
  // Log what the driver was actually shown, not what was classified: during a
  // minimum-hold the two differ, and the trip log is the artefact used to
  // validate the system.
  const displayed = setAlert(alert, governing);
  appendLog(position, motion, governing, displayed, timestamp);
}

/* ------------------------------------------------------- corridor fetching */

function refreshCorridor(position, heading, lookAhead) {
  const now = Date.now();
  if (state.inFlight) return;
  if (now - state.lastFetchAt < MIN_FETCH_INTERVAL_MS) return;
  if (now - state.lastFetchFailedAt < FETCH_BACKOFF_MS) return;

  state.lastFetchAt = now;
  const sequence = ++state.fetchSequence;
  const controller = new AbortController();
  state.inFlight = controller;

  const query = new URLSearchParams({
    lat: position.latitude.toFixed(6),
    lon: position.longitude.toFixed(6),
    lookahead: Math.round(lookAhead)
  });
  if (Number.isFinite(heading)) query.set('heading', heading.toFixed(1));

  // Hard deadline as well as the abort handle: without it a request that never
  // settles leaves `inFlight` set forever and silently blocks every refresh.
  const deadline = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  fetch(`/api/road-ahead?${query}`, { signal: controller.signal })
    .then(async response => {
      if (response.ok) return response.json();
      let detail = `HTTP ${response.status}`;
      try {
        const errorPayload = await response.json();
        if (errorPayload.details) detail = `${errorPayload.error}: ${errorPayload.details}`;
        else if (errorPayload.error) detail = errorPayload.error;
      } catch {
        /* ignore non-json error responses */
      }
      return Promise.reject(new Error(detail));
    })
    .then(payload => {
      // Discard a response that a newer request has already superseded. Part 4
      // had no such guard, so a slow reply could overwrite fresher geometry.
      if (sequence !== state.fetchSequence) return;
      state.tracker.setCorridor(payload);
      state.lastFetchFailureReason = null;
    })
    .catch(error => {
      if (sequence !== state.fetchSequence) return;
      state.lastFetchFailedAt = Date.now();
      const reason = error.name === 'AbortError' ? 'client request timed out (>8s)' : error.message;
      state.lastFetchFailureReason = reason;
      setStatus(`Road geometry unavailable (${reason}). Warnings are suspended until it returns.`, 'warn');
      state.statusIsStale = true;
    })
    .finally(() => {
      clearTimeout(deadline);
      if (state.inFlight === controller) state.inFlight = null;
    });
}

/* ----------------------------------------------------------------- alerts */

const LEVEL_RANK = { none: 0, advisory: 1, warning: 2, brake: 3 };

/**
 * Apply an alert level to the UI and return the level actually displayed.
 *
 * Sound and speech fire only on ESCALATION. Firing on any change meant one
 * correctly executed braking manoeuvre produced three separate alerts —
 * brake, then warning, then advisory — as urgency fell, so the driver was
 * beeped at for doing the right thing and the last thing they heard entering
 * the curve was the mildest alert.
 */
function setAlert(alert, governing) {
  const now = Date.now();
  const previousRank = LEVEL_RANK[state.alertLevel] ?? 0;
  const nextRank = LEVEL_RANK[alert.level] ?? 0;

  // Hold a level briefly so nothing flashes. Applies to any downgrade, not only
  // to clearing: a BRAKE banner replaced after 200 ms is unreadable.
  if (nextRank < previousRank && now - state.alertSince < MIN_ALERT_MS) return state.alertLevel;

  const changed = alert.level !== state.alertLevel;
  if (changed) {
    state.alertLevel = alert.level;
    state.alertSince = now;
  }

  document.body.dataset.alert = alert.level;
  const inCurve = Boolean(governing && governing.inCurve);
  dom.warning.textContent = alert.level === 'none'
    ? ''
    : `${alertLabel(alert.level, inCurve)}${governing
        ? (inCurve
            ? ` — ${governing.advisorySpeedKmh.toFixed(0)} km/h for this curve`
            : ` — ${governing.advisorySpeedKmh.toFixed(0)} km/h in ${governing.distanceAhead.toFixed(0)} m`)
        : ''}`;

  if (changed && nextRank > previousRank) {
    playTone(alert.level);
    announce(alert, governing);
  }
  return alert.level;
}

function playTone(level) {
  if (!settings.audioEnabled || !state.audioContext) return;
  const context = state.audioContext;
  const frequency = level === 'brake' ? 880 : level === 'warning' ? 660 : 480;
  const beeps = level === 'brake' ? 3 : level === 'warning' ? 2 : 1;
  for (let i = 0; i < beeps; i += 1) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime + i * 0.18;
    oscillator.frequency.value = frequency;
    oscillator.type = 'square';
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.16);
  }
  if (navigator.vibrate) navigator.vibrate(level === 'brake' ? [120, 60, 120] : 100);
}

function announce(alert, governing) {
  // A text-only warning is the one channel a driver cannot safely use.
  if (!settings.speechEnabled || !window.speechSynthesis || !governing) return;
  // Keyed by the curve and the level, and NOT reset when the alert clears.
  // Clearing it on 'none' defeated the dedupe entirely: a driver who slows when
  // warned and coasts when the alert clears drops below the release threshold
  // and back over the trigger, so the same curve was announced three times on
  // one approach.
  const token = `${Math.round(governing.radius)}@${Math.round(governing.startDistance ?? governing.radius)}:${alert.level}:${governing.inCurve ? 'in' : 'approach'}`;
  if (state.announcedFor === token) return;
  state.announcedFor = token;
  const utterance = new SpeechSynthesisUtterance(
    governing.inCurve
      ? `Too fast. Ease off. ${governing.advisorySpeedKmh.toFixed(0)}`
      : alert.level === 'brake'
        ? `Brake. Curve ${governing.advisorySpeedKmh.toFixed(0)}`
        : `Curve ahead. ${governing.advisorySpeedKmh.toFixed(0)}`
  );
  utterance.rate = 1.1;
  speechSynthesis.speak(utterance);
}

function setStatus(message, kind = 'info') {
  dom.status.textContent = message;
  dom.status.dataset.kind = kind;
}

/* ------------------------------------------------------------------ logger */

const LOG_HEADER = [
  'timestamp_iso', 'latitude', 'longitude', 'gps_accuracy_m', 'speed_kmh',
  'heading_deg', 'source', 'curve_radius_m', 'curve_median_radius_m',
  'distance_to_curve_m', 'in_curve', 'distance_to_exit_m',
  'superelevation', 'superelevation_source',
  'advisory_speed_kmh', 'advisory_speed_part4_kmh',
  'required_decel_mps2', 'alert_level', 'fetch_failure_reason'
];

function appendLog(position, motion, governing, alertLevel, timestamp) {
  state.log.push([
    new Date(timestamp).toISOString(),
    position.coords.latitude.toFixed(7),
    position.coords.longitude.toFixed(7),
    Number.isFinite(motion.accuracy) ? motion.accuracy.toFixed(1) : '',
    motion.speedKmh.toFixed(2),
    Number.isFinite(motion.headingDegrees) ? motion.headingDegrees.toFixed(1) : '',
    dom.datasource.textContent,
    governing ? governing.radius.toFixed(2) : '',
    governing && Number.isFinite(governing.medianRadius) ? governing.medianRadius.toFixed(2) : '',
    governing ? governing.distanceAhead.toFixed(1) : '',
    governing ? (governing.inCurve ? '1' : '0') : '',
    governing && Number.isFinite(governing.distanceToExit) ? governing.distanceToExit.toFixed(1) : '',
    governing && Number.isFinite(governing.superelevation) ? governing.superelevation.toFixed(4) : '',
    governing ? (governing.superelevationSource || 'assumed-zero') : '',
    governing ? governing.advisorySpeedKmh.toFixed(2) : '',
    governing ? advisorySpeedPart4(governing.radius).toFixed(2) : '',
    governing && Number.isFinite(governing.requiredDeceleration) ? governing.requiredDeceleration.toFixed(3) : '',
    alertLevel,
    state.lastFetchFailureReason || ''
  ]);
  dom.logcount.textContent = String(state.log.length);
}

function downloadLog() {
  if (state.log.length === 0) return;
  const escapeCsv = cell => {
    const text = cell === null || cell === undefined ? '' : String(cell);
    return text.includes(',') || text.includes('"') || text.includes('\n')
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  const csv = [LOG_HEADER.join(','), ...state.log.map(row =>
    row.map(escapeCsv).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `curve-warning-trip-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ----------------------------------------------------------- service worker */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {});
}

/* ----------------------------------------------- friction reference readout */

(function showFrictionReference() {
  const element = document.getElementById('frictionreference');
  if (!element) return;
  const rows = [30, 50, 70, 90, 110].map(speed =>
    `${speed}: ${sideFriction(speed, 'aashto').toFixed(3)}`).join('  ·  ');
  element.textContent = `f(V) — ${rows}`;
}());

resetReadout();
setStatus('Ready. Press Start and allow location access.', 'info');
