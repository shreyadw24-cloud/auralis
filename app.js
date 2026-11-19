// Auralis main file. Connects the belt (BLE), camera, risk rules, voice and SOS.
// Plain ES module. No framework. Modules are loaded safely so one failure does not stop the app.

const M = {}; // Loaded modules: ble, speech, detect, risk, sos

// Short helper to get an element by id. Warns if it is missing.
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) console.warn('Missing element: ' + id);
  return el;
};

const state = {
  muted: false,
  objects: [],          // latest camera objects
  esp: { frontCm: null, downCm: null, dropWarning: false, fallDetected: false },
  lastFall: false,      // previous fallDetected value
  fallSosSent: false,   // true after the first fall SOS
  lastDropAt: 0,        // time of the last drop alert
  lastRiskMsg: '',      // last risk message that was spoken
  lastRiskAt: 0,        // time when the last risk message was spoken
  simPersonUntil: 0,    // time when the simulated person ends
  cameraOn: false,
};

// Safely run a function so one error does not stop other features.
function safe(fn, label) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => console.warn(label, e));
    return r;
  } catch (e) {
    console.warn(label, e);
  }
}

// Add a line to the alert log (keep only the last 5 lines).
function logLine(text, withTime = true) {
  const log = $('alertLog');
  if (!log) return;
  const li = document.createElement('li');
  li.textContent = withTime ? new Date().toLocaleTimeString() + ' - ' + text : text;
  log.appendChild(li);
  while (log.children.length > 5) log.removeChild(log.firstChild);
}

// Set text of an element if it exists.
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

// Show or hide an element using the hidden attribute.
function setHidden(id, hidden) {
  const el = $(id);
  if (el) el.hidden = hidden;
}

// Load one module with try/catch. Show a message if it fails.
async function loadModule(name) {
  try {
    M[name] = await import('./' + name + '.js');
  } catch (e) {
    console.warn(name + ' not loaded', e);
    logLine(name + ' not loaded', false);
  }
}

// Speak text unless muted. Checks that speak() exists.
function say(text, priority) {
  if (state.muted) return;
  if (M.speech && typeof M.speech.speak === 'function') safe(() => M.speech.speak(text, priority), 'speak');
}

// Send a vibration command to the belt if possible.
function send(ch) {
  if (M.ble && typeof M.ble.sendCommand === 'function') safe(() => M.ble.sendCommand(ch), 'sendCommand');
}

// Show connection status on the status pill.
function onStatus(status) {
  const pill = $('statusPill');
  let key = 'disconnected';
  let text = 'Disconnected';
  if (status === 'connected') { key = 'connected'; text = 'Connected'; }
  else if (status === 'connecting') { key = 'connecting'; text = 'Connecting'; }
  else if (typeof status === 'string' && status.startsWith('error')) { key = 'error'; text = 'Error'; }
  if (pill) { pill.textContent = text; pill.dataset.state = key; }
  if (key === 'error') logLine(String(status));
}

// Handle new data from the belt (or from the simulator).
function onData(d) {
  state.esp = {
    frontCm: d.frontCm, downCm: d.downCm,
    dropWarning: !!d.dropWarning, fallDetected: !!d.fallDetected,
  };
  const front = $('frontCm');
  if (front) {
    front.textContent = d.frontCm == null ? '--' : String(d.frontCm);
    const v = d.frontCm;
    front.dataset.level = v == null ? '' : v > 150 ? 'far' : v >= 50 ? 'mid' : 'near';
  }
  setText('downCm', d.downCm == null ? '--' : String(d.downCm));
  setHidden('dropBanner', !d.dropWarning);
  setHidden('fallBanner', !d.fallDetected);

  // Trigger SOS only the first time a fall starts.
  if (d.fallDetected && !state.lastFall && !state.fallSosSent) {
    state.fallSosSent = true;
    if (M.sos && typeof M.sos.triggerSos === 'function') safe(() => M.sos.triggerSos('device'), 'triggerSos');
  }
  if (!d.fallDetected) state.fallSosSent = false;
  state.lastFall = !!d.fallDetected;

  if (d.gpsLat != null && d.gpsLon != null) {
    setText('gpsInfo', 'GPS: ' + Number(d.gpsLat).toFixed(5) + ', ' + Number(d.gpsLon).toFixed(5));
    if (M.sos && typeof M.sos.setBeltLocation === 'function') safe(() => M.sos.setBeltLocation(d.gpsLat, d.gpsLon), 'setBeltLocation');
  } else {
    setText('gpsInfo', 'GPS: no fix');
  }
}

// Read the simulator controls and feed them like BLE data.
function simTick() {
  const on = $('simOn');
  if (!on || !on.checked) return;
  const val = (id) => { const e = document.getElementById(id); return e ? Number(e.value) : 0; };
  const chk = (id) => { const e = document.getElementById(id); return e ? e.checked : false; };
  onData({
    frontCm: val('simFront'), downCm: val('simDown'),
    dropWarning: chk('simDrop'), fallDetected: chk('simFall'),
    gpsLat: null, gpsLon: null,
  });
}

// Handle objects from the camera detector.
function onObjects(list) {
  state.objects = Array.isArray(list) ? list : [];
}

// Run the risk rules every 200 ms and react to the result.
function riskTick() {
  const now = Date.now();
  let objects = state.objects;
  if (now < state.simPersonUntil) {
    objects = objects.concat([{ label: 'person', score: 0.9, zone: 'C', areaRatio: 0.3 }]);
  }
  const { frontCm, dropWarning } = state.esp;

  // Drop alert works even without risk.js (at most once every 3 seconds).
  if (dropWarning && now - state.lastDropAt > 3000) {
    state.lastDropAt = now;
    say('Careful, there are stairs or a drop ahead', 'high');
    send('A');
  }

  if (!M.risk || typeof M.risk.evaluateRisk !== 'function') return;
  const r = M.risk.evaluateRisk({ objects, frontCm, dropWarning });
  if (!r || r.level === 'none') { state.lastRiskMsg = ''; setText('alertLive', ''); return; }
  setText('alertLive', r.message);
  // Speak, vibrate and log only when the message changes, or every 4 seconds.
  // This stops the voice from restarting every 200 ms.
  const isNew = r.message !== state.lastRiskMsg;
  if (!isNew && now - state.lastRiskAt < 4000) return;
  state.lastRiskMsg = r.message;
  state.lastRiskAt = now;
  if (now - state.lastDropAt > 2500) say(r.message, r.level === 'danger' ? 'high' : 'normal');
  if (r.vibrate) send(r.vibrate);
  if (isNew) logLine(r.message);
}

// Connect to the belt over Bluetooth LE.
function handleConnect() {
  if (!navigator.bluetooth) { logLine('Use Android Chrome', false); return; }
  if (M.speech && typeof M.speech.unlockSpeech === 'function') safe(() => M.speech.unlockSpeech(), 'unlockSpeech');
  if (!M.ble || typeof M.ble.connectBle !== 'function') { logLine('ble not loaded', false); return; }
  safe(() => M.ble.connectBle(onData, onStatus), 'connectBle');
}

// Start the camera and object detection.
async function handleCamera() {
  if (!M.detect || typeof M.detect.startDetection !== 'function') { logLine('detect not loaded', false); return; }
  try {
    await M.detect.startDetection($('video'), $('overlay'), onObjects);
    state.cameraOn = true;
  } catch (e) {
    logLine('Camera error: ' + (e && e.message ? e.message : e));
  }
}

// Toggle the muted flag and update the button.
function handleMute() {
  state.muted = !state.muted;
  const b = $('btnMute');
  if (b) {
    b.textContent = state.muted ? 'Unmute voice' : 'Mute voice';
    b.setAttribute('aria-pressed', String(state.muted));
  }
  if (M.speech && typeof M.speech.setMuted === 'function') safe(() => M.speech.setMuted(state.muted), 'setMuted');
}

// Add a click listener to an element if it exists.
function on(id, fn) {
  const el = $(id);
  if (el) el.addEventListener('click', () => safe(fn, id));
}

// Start the app: load modules, connect buttons, start timers.
async function init() {
  if (!navigator.bluetooth) logLine('Use Android Chrome', false);
  await Promise.all(['ble', 'speech', 'detect', 'risk', 'sos'].map(loadModule));
  if (M.sos && typeof M.sos.initSos === 'function') safe(() => M.sos.initSos(), 'initSos');

  on('btnConnect', handleConnect);
  on('btnCamera', handleCamera);
  on('btnMute', handleMute);
  on('btnTestL', () => send('L'));
  on('btnTestC', () => send('C'));
  on('btnTestR', () => send('R'));
  on('btnSos', () => {
    if (M.sos && typeof M.sos.triggerSos === 'function') M.sos.triggerSos('button');
  });
  on('simPerson', () => { state.simPersonUntil = Date.now() + 3000; });

  setInterval(() => safe(simTick, 'sim'), 200);
  setInterval(() => safe(riskTick, 'risk'), 200);
}

init();