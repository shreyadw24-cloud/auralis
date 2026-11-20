// sos.js - SOS countdown, then auto-send to Telegram (WhatsApp link is the backup).
// Cancel: tap anywhere on the screen, or press the belt button (see app.js).

// ===== Fill these (leave empty to use only the WhatsApp link) =====
const TELEGRAM_TOKEN = "9229037781:AAGj-6yBVQgm-m6dO5jfk8lDwBMPAO81XTc";    // from @BotFather
const TELEGRAM_CHAT_ID = "8485410995";  // from api.telegram.org/bot<TOKEN>/getUpdates
const WHATSAPP_NUMBER = "8527741611";   // backup, with country code, e.g. "919876543210"

let countdownTimer = null;
let countdownValue = 10;
let beltLocation = null;
let cooldownUntil = 0;
let isSending = false;
let sendCancelled = false;
let listenersInitialized = false;
let currentReason = "button";

// Get the SOS panel elements.
function getElements() {
  return {
    panel: document.getElementById("sosPanel"),
    countdown: document.getElementById("sosCountdown"),
    cancelButton: document.getElementById("btnSosCancel"),
    sendButton: document.getElementById("btnSosSendNow")
  };
}

// Hide the SOS panel.
function hidePanel() {
  const el = getElements();
  if (el.panel) el.panel.hidden = true;
}

// Speak a message if speech.js is available.
function speakSafe(text) {
  import("./speech.js")
    .then((m) => m.speak(text, "high"))
    .catch(() => {});
}

// Get a recent GPS location from the belt or the phone.
async function getLocation() {
  if (beltLocation && Date.now() - beltLocation.timestamp <= 30000) {
    return { lat: beltLocation.lat, lng: beltLocation.lng };
  }
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

// Send the SOS to Telegram. Returns true if it worked.
async function sendTelegram(text, loc) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const base = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;
  const post = (method, body) =>
    fetch(base + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  try {
    const r = await post("sendMessage", { chat_id: TELEGRAM_CHAT_ID, text });
    if (!r.ok) return false;
    if (loc) await post("sendLocation", { chat_id: TELEGRAM_CHAT_ID, latitude: loc.lat, longitude: loc.lng });
    return true;
  } catch (e) {
    return false;
  }
}

// Send the SOS (Telegram first, WhatsApp link if Telegram fails).
async function sendSos() {
  if (isSending) return;
  isSending = true;
  sendCancelled = false;

  clearInterval(countdownTimer);
  countdownTimer = null;

  try {
    const loc = await getLocation();
    if (sendCancelled) return; // user cancelled while location was loading

    const why = currentReason === "button" ? "SOS button pressed" : "fall detected";
    let message = "SOS! I need help. Reason: " + why + ".";
    if (loc) message += " My location: https://maps.google.com/?q=" + loc.lat + "," + loc.lng;

    cooldownUntil = Date.now() + 60000;
    hidePanel();

    const ok = await sendTelegram(message, loc);
    if (ok) {
      speakSafe("SOS sent.");
    } else {
      speakSafe("Could not send automatically. Opening WhatsApp.");
      window.location.href = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(message);
    }
  } catch (error) {
    console.error("SOS sending error:", error);
    hidePanel();
  } finally {
    isSending = false;
  }
}

// Initialize the SOS listeners once.
export function initSos() {
  if (listenersInitialized) return;
  const el = getElements();
  if (!el.panel || !el.countdown || !el.cancelButton || !el.sendButton) {
    console.error("SOS HTML elements are missing.");
    return;
  }
  el.cancelButton.addEventListener("click", cancelSos);
  el.sendButton.addEventListener("click", sendSos);
  // Tap anywhere on the panel cancels (except the "send now" button).
  el.panel.addEventListener("click", (e) => {
    if (e.target.closest("#btnSosSendNow")) return;
    cancelSos();
  });
  listenersInitialized = true;
}

// Start the 10-second SOS countdown. The belt button ('button') ignores the cooldown.
export function triggerSos(reason) {
  if (reason !== "button" && Date.now() < cooldownUntil) return;
  if (isSending) return;

  const el = getElements();
  if (!el.panel || !el.countdown) return;
  if (!el.panel.hidden) return;

  currentReason = reason || "button";
  el.panel.hidden = false;
  countdownValue = 10;
  el.countdown.textContent = countdownValue;

  speakSafe("SOS will be sent in 10 seconds. Tap anywhere on the screen or press the belt button to cancel.");

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdownValue--;
    el.countdown.textContent = countdownValue;
    if (countdownValue <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      sendSos();
    }
  }, 1000);
}

// Cancel SOS (only does something if the panel is open).
export function cancelSos() {
  const el = getElements();
  const wasOpen = el.panel && !el.panel.hidden;
  clearInterval(countdownTimer);
  countdownTimer = null;
  sendCancelled = true;
  if (!wasOpen) return;
  cooldownUntil = Date.now() + 60000;
  hidePanel();
  speakSafe("SOS cancelled.");
}

// Store the latest GPS coordinates received from the belt.
export function setBeltLocation(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
  beltLocation = { lat, lng, timestamp: Date.now() };
}