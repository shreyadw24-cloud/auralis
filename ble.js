// ble.js - Web Bluetooth module for Auralis ESP32 belt (Nordic UART Service)

const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Phone writes commands (L/C/R/A)
const TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Phone receives notifications

let bleDevice = null;
let bleServer = null;
let rxChar = null;
let txChar = null;

let dataCallback = null;
let statusCallback = null;
let rawLineCallback = null; // Optional helper for ble-test.html raw log

let lineBuffer = '';
let latestGpsLat = null;
let latestGpsLon = null;

let lastCmdTime = 0;
let manualDisconnect = false;
let reconnecting = false;

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

// Optional helper for ble-test.html to display last 10 raw lines
export function setRawLineListener(fn) {
  rawLineCallback = fn;
}

// Safely notify status callback
function reportStatus(statusText) {
  if (typeof statusCallback === 'function') {
    statusCallback(statusText);
  }
}

// Parse one complete newline-terminated line from ESP32
function parseLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return;

  if (typeof rawLineCallback === 'function') {
    rawLineCallback(line);
  }

  try {
    // Handle GPS line: G:28.61234,77.20901
    if (line.startsWith('G:')) {
      const coords = line.slice(2).split(',');
      if (coords.length === 2) {
        const lat = parseFloat(coords[0]);
        const lon = parseFloat(coords[1]);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          latestGpsLat = lat;
          latestGpsLon = lon;
        }
      }
      return;
    }

    // Handle sensor telemetry line: F:85,D:30,W:0,X:0
    if (line.startsWith('F:')) {
      const parts = line.split(',');
      const values = {};

      for (const part of parts) {
        const [key, val] = part.split(':');
        if (key && val !== undefined) {
          values[key.trim()] = parseInt(val.trim(), 10);
        }
      }

      if (
        Number.isNaN(values.F) ||
        Number.isNaN(values.D) ||
        Number.isNaN(values.W) ||
        Number.isNaN(values.X)
      ) {
        return; // Ignore malformed or incomplete lines without crashing
      }

      if (typeof dataCallback === 'function') {
        dataCallback({
          frontCm: values.F,
          downCm: values.D,
          dropWarning: values.W === 1,
          fallDetected: values.X === 1,
          gpsLat: latestGpsLat,
          gpsLon: latestGpsLon
        });
      }
    }
  } catch (err) {
    // Ignore corrupted serial packets safely
  }
}

// Handle incoming BLE notification byte chunks and buffer until '\n'
function onTxNotification(event) {
  const value = event.target.value;
  if (!value) return;

  lineBuffer += decoder.decode(value, { stream: true });
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop(); // Keep unfinished tail in buffer

  for (const line of lines) {
    parseLine(line);
  }
}

// Connect GATT server, get service/characteristics, and start notifications
async function connectGatt() {
  if (!bleDevice) throw new Error('No BLE device selected');

  reportStatus('connecting');
  bleServer = await bleDevice.gatt.connect();
  const service = await bleServer.getPrimaryService(SERVICE_UUID);

  rxChar = await service.getCharacteristic(RX_UUID);
  txChar = await service.getCharacteristic(TX_UUID);

  await txChar.startNotifications();
  txChar.removeEventListener('characteristicvaluechanged', onTxNotification);
  txChar.addEventListener('characteristicvaluechanged', onTxNotification);

  lineBuffer = '';
  reportStatus('connected');
}

// Handle unexpected BLE disconnection and try 3 auto-reconnects (2s gap)
async function handleDisconnected() {
  rxChar = null;
  txChar = null;
  reportStatus('disconnected');

  if (manualDisconnect || reconnecting || !bleDevice) return;

  reconnecting = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (manualDisconnect || !bleDevice) break;

    try {
      await connectGatt();
      reconnecting = false;
      return;
    } catch (err) {
      if (attempt === 3) {
        reportStatus('disconnected');
      }
    }
  }
  reconnecting = false;
}

// Request Auralis-Belt device and open BLE connection
export async function connectBle(onData, onStatus) {
  dataCallback = onData;
  statusCallback = onStatus;
  manualDisconnect = false;

  if (!navigator.bluetooth) {
    reportStatus('error: Use Android Chrome');
    return;
  }

  try {
    reportStatus('connecting');
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Auralis' }],
      optionalServices: [SERVICE_UUID]
    });

    bleDevice.removeEventListener('gattserverdisconnected', handleDisconnected);
    bleDevice.addEventListener('gattserverdisconnected', handleDisconnected);

    await connectGatt();
  } catch (err) {
    reportStatus(`error: ${err.message || 'Connection failed'}`);
  }
}

// Send a single motor command ('L', 'C', 'R', 'A') to ESP32 with 300ms throttle
export async function sendCommand(ch) {
  if (!rxChar || !bleDevice || !bleDevice.gatt || !bleDevice.gatt.connected) {
    return; // Silently ignore if not connected
  }
  if (!['L', 'C', 'R', 'A'].includes(ch)) return;

  const now = Date.now();
  if (now - lastCmdTime < 300) return; // 300ms throttle
  lastCmdTime = now;

  const bytes = encoder.encode(ch);
  try {
    if (typeof rxChar.writeValueWithoutResponse === 'function') {
      await rxChar.writeValueWithoutResponse(bytes);
    } else {
      await rxChar.writeValue(bytes);
    }
  } catch (err) {
    try {
      await rxChar.writeValue(bytes);
    } catch (_) {
      // Ignore transient write errors
    }
  }
}

// Manually disconnect from the ESP32 belt and stop auto-reconnect
export function disconnectBle() {
  manualDisconnect = true;
  reconnecting = false;
  if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
  rxChar = null;
  txChar = null;
  reportStatus('disconnected');
}