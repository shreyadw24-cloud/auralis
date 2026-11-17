// risk.js - decides if an alert is needed from camera objects and belt distance.
// Pure logic only: no DOM, no side effects.

// ---- Constants (change names here if needed) ----
const NAME_PERSON = 'person';
const NAME_VEHICLE = 'vehicle';

const PERSON_LABELS = ['person'];
const VEHICLE_LABELS = ['car', 'bus', 'truck', 'motorcycle', 'bicycle'];

const SIDE_NAMES = { L: 'left', R: 'right' };

const DROP_MESSAGE = 'Warning, stairs or a drop ahead';
const OBSTACLE_MESSAGE = 'Warning, obstacle ahead';

// Distance limits (cm)
const FRONT_MIN_VALID = 2;
const FRONT_MAX_VALID = 399; // 400 means no echo
const DANGER_BELOW_CM = 100;
const WARNING_UPTO_CM = 150;
const NO_OBJECT_DANGER_CM = 50;

// Area ratio limits
const CENTER_AREA_LIMIT = 0.3;
const SIDE_AREA_LIMIT = 0.25;

// Higher number = higher priority (vehicle first, then person)
const PRIORITY_VEHICLE = 2;
const PRIORITY_PERSON = 1;

// Returns true if the belt distance is a real reading.
function isValidDistance(frontCm) {
  return (
    typeof frontCm === 'number' &&
    Number.isFinite(frontCm) &&
    frontCm >= FRONT_MIN_VALID &&
    frontCm <= FRONT_MAX_VALID
  );
}

// Maps a camera label to { name, priority }, or null if we do not track it.
function getCategory(label) {
  if (VEHICLE_LABELS.includes(label)) {
    return { name: NAME_VEHICLE, priority: PRIORITY_VEHICLE };
  }
  if (PERSON_LABELS.includes(label)) {
    return { name: NAME_PERSON, priority: PRIORITY_PERSON };
  }
  return null;
}

// Converts cm to meters with one decimal place (e.g. 85 -> "0.9").
function toMeters(cm) {
  return (cm / 100).toFixed(1);
}

// Makes the first letter of a word uppercase (e.g. "person" -> "Person").
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Checks one object against rules 3-6.
// Returns { level, message, vibrate } or null if this object needs no alert.
function checkObject(obj, category, frontCm, frontValid) {
  const zone = obj.zone;
  const area = typeof obj.areaRatio === 'number' ? obj.areaRatio : 0;

  if (zone === 'C') {
    // Rule 3: very close in front.
    if (frontValid && frontCm < DANGER_BELOW_CM) {
      return {
        level: 'danger',
        message: `Warning, ${category.name} ahead, ${toMeters(frontCm)} meters`,
        vibrate: 'C',
      };
    }
    // Rule 4: close in front.
    if (frontValid && frontCm <= WARNING_UPTO_CM) {
      return {
        level: 'warning',
        message: `${capitalize(category.name)} ahead, ${toMeters(frontCm)} meters`,
        vibrate: 'C',
      };
    }
    // Rule 5: no distance reading, but the object looks big in the camera.
    if (!frontValid && area > CENTER_AREA_LIMIT) {
      return {
        level: 'warning',
        message: `${capitalize(category.name)} ahead, close by`,
        vibrate: 'C',
      };
    }
    return null;
  }

  // Rule 6: big object on the left or right side.
  if ((zone === 'L' || zone === 'R') && area > SIDE_AREA_LIMIT) {
    return {
      level: 'warning',
      message: `${capitalize(category.name)} close on your ${SIDE_NAMES[zone]}`,
      vibrate: zone,
    };
  }

  return null;
}

// Main function used by app.js.
// Input:  { objects, frontCm, dropWarning }
// Output: { level, message, vibrate }
export function evaluateRisk({ objects = [], frontCm, dropWarning } = {}) {
  // Rule 1: a drop or stairs warning always wins.
  if (dropWarning === true) {
    return { level: 'danger', message: DROP_MESSAGE, vibrate: 'A' };
  }

  const frontValid = isValidDistance(frontCm);

  // Keep only objects we track, and collect the ones that need an alert.
  const alerts = [];
  let trackedCount = 0;
  for (const obj of Array.isArray(objects) ? objects : []) {
    const category = obj ? getCategory(obj.label) : null;
    if (!category) continue;
    trackedCount += 1;

    const result = checkObject(obj, category, frontCm, frontValid);
    if (result) {
      alerts.push({
        result,
        priority: category.priority,
        area: typeof obj.areaRatio === 'number' ? obj.areaRatio : 0,
      });
    }
  }

  // Pick the best alert: vehicle before person, then bigger area.
  if (alerts.length > 0) {
    alerts.sort((a, b) => b.priority - a.priority || b.area - a.area);
    return alerts[0].result;
  }

  // Rule 7: no camera object, but the belt sees something very close.
  if (trackedCount === 0 && frontValid && frontCm < NO_OBJECT_DANGER_CM) {
    return { level: 'danger', message: OBSTACLE_MESSAGE, vibrate: 'C' };
  }

  // Rule 8: nothing to report.
  return { level: 'none', message: '', vibrate: null };
}