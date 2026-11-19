
let currentUtterance = null;

// Speak a message using the browser's speech synthesis.
export function speak(message, priority = "normal") {
  if (!("speechSynthesis" in window)) {
    console.error("Speech synthesis is not supported by this browser.");
    return;
  }

  if (!message || typeof message !== "string") {
    console.error("Invalid speech message.");
    return;
  }

  // Stop any previous announcement.
  window.speechSynthesis.cancel();

  currentUtterance = new SpeechSynthesisUtterance(message);

  // English voice settings.
  currentUtterance.lang = "en-US";
  currentUtterance.rate = 1;
  currentUtterance.pitch = 1;
  currentUtterance.volume = 1;

  currentUtterance.onend = () => {
    currentUtterance = null;
  };

  currentUtterance.onerror = (event) => {
    console.error("Speech error:", event.error);
    currentUtterance = null;
  };

  window.speechSynthesis.speak(currentUtterance);
}

// Stop the current voice announcement.
export function stopSpeaking() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    currentUtterance = null;
  }
}
