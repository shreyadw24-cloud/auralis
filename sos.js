
let countdownTimer = null;
let countdownValue = 10;

let beltLocation = null;
let cooldownUntil = 0;
let isSending = false;

let listenersInitialized = false;

// Get the SOS panel elements.
function getElements() {
  return {
    panel: document.getElementById("sosPanel"),
    countdown: document.getElementById("sosCountdown"),
    cancelButton: document.getElementById("btnSosCancel"),
    sendButton: document.getElementById("btnSosSendNow")
  };
}

// Hide the SOS panel and stop its countdown.
function hidePanel() {
  const elements = getElements();

  if (elements.panel) {
    elements.panel.hidden = true;
  }
}

// Get a recent GPS location from the belt or phone.
async function getLocation() {

  // Use belt GPS if its location is less than 30 seconds old.
  if (
    beltLocation &&
    Date.now() - beltLocation.timestamp <= 30000
  ) {
    return {
      lat: beltLocation.lat,
      lng: beltLocation.lng
    };
  }

  // Otherwise, try the phone's location.
  if (!navigator.geolocation) {
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      }
    );
  });
}

// Open a prepared WhatsApp SOS message.
async function sendSos() {
  if (isSending) return;

  isSending = true;

  clearInterval(countdownTimer);
  countdownTimer = null;

  try {
    const location = await getLocation();

    // English SOS message.
    let message = "SOS! I need help.";

    if (location) {
      message +=
        " My location: https://maps.google.com/?q=" +
        location.lat +
        "," +
        location.lng;
    }

    const whatsappUrl =
      "https://wa.me/?text=" + encodeURIComponent(message);

    window.open(whatsappUrl, "_blank");

    cooldownUntil = Date.now() + 60000;

    hidePanel();

  } catch (error) {
    console.error("SOS sending error:", error);
    hidePanel();

  } finally {
    isSending = false;
  }
}

// Initialize the SOS button listeners once.
export function initSos() {
  if (listenersInitialized) return;

  const elements = getElements();

  if (
    !elements.panel ||
    !elements.countdown ||
    !elements.cancelButton ||
    !elements.sendButton
  ) {
    console.error("SOS HTML elements are missing.");
    return;
  }

  elements.cancelButton.addEventListener("click", cancelSos);
  elements.sendButton.addEventListener("click", sendSos);

  listenersInitialized = true;
}

// Start the 10-second SOS countdown.
export function triggerSos(reason) {
  if (Date.now() < cooldownUntil || isSending) return;

  const elements = getElements();

  if (!elements.panel || !elements.countdown) return;

  if (!elements.panel.hidden) return;

  elements.panel.hidden = false;

  countdownValue = 10;
  elements.countdown.textContent = countdownValue;

  // Announce the SOS message in English.
  import("./speech.js")
    .then((module) => {
      module.speak(
        "SOS will be sent in 10 seconds. Press Cancel to stop it.",
        "high"
      );
    })
    .catch(() => {
      // Voice module is optional during standalone testing.
    });

  clearInterval(countdownTimer);

  countdownTimer = setInterval(() => {
    countdownValue--;

    elements.countdown.textContent = countdownValue;

    if (countdownValue <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      sendSos();
    }
  }, 1000);
}

// Cancel SOS and activate the cooldown.
export function cancelSos() {
  clearInterval(countdownTimer);
  countdownTimer = null;

  cooldownUntil = Date.now() + 60000;

  hidePanel();
}

// Store the latest GPS coordinates received from the belt.
export function setBeltLocation(lat, lng) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return;
  }

  beltLocation = {
    lat,
    lng,
    timestamp: Date.now()
  };
}
