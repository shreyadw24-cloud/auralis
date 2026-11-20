// speech.js - Voice alert module for Auralis wearable assistant

let selectedVoice = null;
let isMuted = false;
let speechQueue = [];
let isSpeaking = false;
let lastSpokenText = '';
let lastSpokenTime = 0;

// Pick preferred voice: en-IN first, then hi-IN, then default
function chooseVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return;

  selectedVoice =
    voices.find(v => v.lang.toLowerCase() === 'en-in') ||
    voices.find(v => v.lang.toLowerCase().startsWith('en-in')) ||
    voices.find(v => v.lang.toLowerCase() === 'hi-in') ||
    voices.find(v => v.lang.toLowerCase().startsWith('hi-in')) ||
    voices.find(v => v.default) ||
    voices[0];

  // Dispatch custom event so test page can display the active voice
  window.dispatchEvent(new CustomEvent('auralis-voice-changed', {
    detail: selectedVoice ? `${selectedVoice.name} (${selectedVoice.lang})` : 'Default Browser Voice'
  }));
}

// Voices often load asynchronously in Chrome
if ('speechSynthesis' in window) {
  chooseVoice();
  window.speechSynthesis.onvoiceschanged = chooseVoice;
}

// Helper to returned currently selected voice name for UI/testing
export function getSelectedVoiceName() {
  if (!('speechSynthesis' in window)) return 'Speech Synthesis not supported';
  if (!selectedVoice) chooseVoice();
  return selectedVoice ? `${selectedVoice.name} (${selectedVoice.lang})` : 'Default Browser Voice';
}

// Play next utterance from the normal queue
function processQueue() {
  if (isMuted || !('speechSynthesis' in window)) {
    speechQueue = [];
    isSpeaking = false;
    return;
  }
  if (isSpeaking || speechQueue.length === 0) return;

  const nextText = speechQueue.shift();
  playUtterance(nextText);
}

// Create and speak a SpeechSynthesisUtterance
function playUtterance(text) {
  if (!('speechSynthesis' in window) || isMuted) return;

  isSpeaking = true;
  const utterance = new SpeechSynthesisUtterance(text);
  if (!selectedVoice) chooseVoice();
  if (selectedVoice) utterance.voice = selectedVoice;
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  utterance.onend = () => {
    isSpeaking = false;
    processQueue();
  };

  utterance.onerror = () => {
    isSpeaking = false;
    processQueue();
  };

  window._utt = utterance; // keep a reference so Chrome does not garbage-collect it
  window.speechSynthesis.speak(utterance);
}

// Speak alert text with 'normal' or 'high' priority
export function speak(text, priority = 'normal') {
  if (!('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported in this browser.');
    return;
  }
  if (isMuted || !text || !text.trim()) return;

  const cleanText = text.trim();
  const now = Date.now();

  // Do not repeat the exact same text within 3 seconds
  if (cleanText === lastSpokenText && now - lastSpokenTime < 3000) {
    return;
  }
  lastSpokenText = cleanText;
  lastSpokenTime = now;

  if (priority === 'high') {
    // Cancel ongoing speech and clear queue to speak immediately
    speechQueue = [];
    window.speechSynthesis.cancel();
    isSpeaking = false;
    setTimeout(() => playUtterance(cleanText), 80); // Android Chrome drops speak() right after cancel()
  } else {
    // Queue normal speech (max 2 items in queue; drop oldest if full)
    if (!isSpeaking && !window.speechSynthesis.speaking) {
      playUtterance(cleanText);
    } else {
      if (speechQueue.length >= 2) {
        speechQueue.shift();
      }
      speechQueue.push(cleanText);
    }
  }
}

// Unlock audio context on first user click (required by mobile Chrome)
export function unlockSpeech() {
  if (!('speechSynthesis' in window)) return;
  const silent = new SpeechSynthesisUtterance('');
  silent.volume = 0;
  window.speechSynthesis.speak(silent);
}

// Mute or unmute voice alerts and cancel ongoing speech if muted
export function setMuted(bool) {
  isMuted = Boolean(bool);
  if (isMuted && 'speechSynthesis' in window) {
    speechQueue = [];
    window.speechSynthesis.cancel();
    isSpeaking = false;
  }
}