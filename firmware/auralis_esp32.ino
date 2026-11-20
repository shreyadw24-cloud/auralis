#include <Wire.h>
#include <Adafruit_VL53L0X.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ================= PINS =================
const int TRIG_FRONT = 19, ECHO_FRONT = 32;
const int TRIG_BOT   = 18, ECHO_BOT   = 33;
const uint8_t MPU_ADDR = 0x68;
const int BUZZER_PIN = 25;
const int BTN_SOS    = 26;
const int MOT_LEFT   = 27;
const int MOT_MID    = 14;
const int MOT_RIGHT  = 13;

HardwareSerial gpsSerial(2);
TinyGPSPlus gps;
Adafruit_VL53L0X tof = Adafruit_VL53L0X();
bool tofReady = false, mpuReady = false;

// ================= THRESHOLDS =================
const float FRONT_WARN_CM     = 45.0;
const float FRONT_CRITICAL_CM = 20.0;
const float BOT_NEAR_CM       = 12.0;
const float BOT_DROPOFF_CM    = 50.0;
const unsigned long PHONE_VIBRATE_MS = 600;

// ================= BLE =================
#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
BLECharacteristic *txChar;
bool bleConnected = false;
unsigned long motorUntil[3] = {0, 0, 0};
unsigned long sosUntil = 0, lastGpsSend = 0;

void handleCmd(char ch) {
  unsigned long until = millis() + PHONE_VIBRATE_MS;
  if (ch == 'L') motorUntil[0] = until;
  else if (ch == 'C') motorUntil[1] = until;
  else if (ch == 'R') motorUntil[2] = until;
  else if (ch == 'A') motorUntil[0] = motorUntil[1] = motorUntil[2] = until;
  else return;
  Serial.printf("Command: %c\n", ch);
}

class ServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer *s) { bleConnected = true; Serial.println("BLE connected"); }
  void onDisconnect(BLEServer *s) {
    bleConnected = false; Serial.println("BLE disconnected");
    BLEDevice::startAdvertising();
  }
};
class RxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) {
    std::string v = c->getValue();
    for (size_t i = 0; i < v.length(); i++) handleCmd(v[i]);
  }
};

void setupBle() {
  BLEDevice::init("Auralis-Belt");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  BLEService *svc = server->createService(SERVICE_UUID);
  txChar = svc->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic *rx = svc->createCharacteristic(
      RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCB());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("BLE advertising as Auralis-Belt");
}

// ================= HELPERS =================
float median3(float a, float b, float c) {
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

float readUltrasonicOnce(int trig, int echo) {
  digitalWrite(trig, LOW); delayMicroseconds(4);
  digitalWrite(trig, HIGH); delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long duration = pulseIn(echo, HIGH, 25000);
  if (duration == 0) return 999.0;
  return (duration * 0.0343) / 2.0;
}

float readUltrasonicClean(int trig, int echo) {
  float s1 = readUltrasonicOnce(trig, echo); delay(12);
  float s2 = readUltrasonicOnce(trig, echo); delay(12);
  float s3 = readUltrasonicOnce(trig, echo);
  return median3(s1, s2, s3);
}

bool initMPU() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B); Wire.write(0x00);
  return (Wire.endTransmission() == 0);
}

float readAccelMagnitudeG() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, (uint8_t)6, (uint8_t)true);
  int16_t rawX = (Wire.read() << 8) | Wire.read();
  int16_t rawY = (Wire.read() << 8) | Wire.read();
  int16_t rawZ = (Wire.read() << 8) | Wire.read();
  float ax = rawX / 16384.0, ay = rawY / 16384.0, az = rawZ / 16384.0;
  return sqrt(ax * ax + ay * ay + az * az);
}

float readTofCm() {
  if (!tofReady) return 999.0;
  VL53L0X_RangingMeasurementData_t m;
  tof.rangingTest(&m, false);
  if (m.RangeStatus != 4 && m.RangeMilliMeter < 2000) return m.RangeMilliMeter / 10.0;
  return 999.0;
}

void feedGPS() { while (gpsSerial.available() > 0) gps.encode(gpsSerial.read()); }

void setMotors(bool l, bool m, bool r) {
  digitalWrite(MOT_LEFT,  l ? HIGH : LOW);
  digitalWrite(MOT_MID,   m ? HIGH : LOW);
  digitalWrite(MOT_RIGHT, r ? HIGH : LOW);
}

void triggerEmergencySOS(const char* reason) {
  setMotors(false, false, false);
  Serial.println("\n*********************************************");
  Serial.printf("  [AURALIS EMERGENCY] Trigger: %s\n", reason);
  if (gps.location.isValid()) {
    Serial.printf("  Maps: https://maps.google.com/?q=%.6f,%.6f\n",
                  gps.location.lat(), gps.location.lng());
  } else {
    Serial.printf("  GPS: SEARCHING (%d sats)\n", gps.satellites.value());
  }
  Serial.println("*********************************************\n");
  sosUntil = millis() + 5000;  // 5 sec tak phone ko X:1 jayega (pehle set karo, taaki beep ke dauran bhi X:1 rahe)
  for (int i = 0; i < 3; i++) {
    digitalWrite(BUZZER_PIN, HIGH); setMotors(true, true, true); delay(150);
    digitalWrite(BUZZER_PIN, LOW);  setMotors(false, false, false); delay(120);
  }
  sosUntil = millis() + 5000;  // beep ke baad phir 5 sec
}

// Fall check: loop ke andar tez (~100 Hz) chalta hai, taaki jhatka miss na ho
void checkFall() {
  if (!mpuReady) return;
  float g = readAccelMagnitudeG();
  if ((g > 2.35 || g < 0.35) && millis() >= sosUntil) {
    triggerEmergencySOS("FALL / HIGH-G IMPACT");
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, 16, 17);

  pinMode(TRIG_FRONT, OUTPUT); pinMode(ECHO_FRONT, INPUT);
  pinMode(TRIG_BOT, OUTPUT);   pinMode(ECHO_BOT, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(MOT_LEFT, OUTPUT); pinMode(MOT_MID, OUTPUT); pinMode(MOT_RIGHT, OUTPUT);
  pinMode(BTN_SOS, INPUT_PULLUP);
  digitalWrite(BUZZER_PIN, LOW);
  setMotors(false, false, false);

  delay(800);
  Wire.begin(21, 22);
  Wire.setClock(100000);   // 100 kHz, stable

  tofReady = tof.begin(0x29, false, &Wire);
  mpuReady = initMPU();

  Serial.println("\n===== AURALIS firmware (BLE) =====");
  Serial.printf("ToF: %s | MPU: %s\n", tofReady ? "OK" : "ERROR", mpuReady ? "OK" : "ERROR");

  setupBle();

  digitalWrite(BUZZER_PIN, HIGH); delay(120); digitalWrite(BUZZER_PIN, LOW);
}

// ================= LOOP =================
void loop() {
  feedGPS();
  while (Serial.available()) handleCmd(Serial.read());  // Serial se L/C/R/A test

  unsigned long now = millis();

  // 1. SOS button
  if (digitalRead(BTN_SOS) == LOW && now >= sosUntil) {
    triggerEmergencySOS("MANUAL SOS BUTTON");
  }

  // 2. Sensors
  float frontUS = readUltrasonicClean(TRIG_FRONT, ECHO_FRONT);
  float botUS   = readUltrasonicClean(TRIG_BOT, ECHO_BOT);
  float tofCm   = readTofCm();
  float fusedFrontCm = min(frontUS, tofCm);

  // 3. Fall detection: checkFall() ab loop ke end mein tez chalta hai; yahan sirf print ke liye value
  float totalG = mpuReady ? readAccelMagnitudeG() : 1.0;
  now = millis();

  // 4. Local decision (phone ke bina bhi chalta hai)
  bool lL = false, lM = false, lR = false, buzz = false;
  bool drop = (botUS > BOT_DROPOFF_CM && botUS < 400.0);
  const char* tag = "PATH_CLEAR";

  if (fusedFrontCm < FRONT_CRITICAL_CM) {
    lL = lM = lR = true; buzz = true; tag = "STOP_CRITICAL";
  } else if (fusedFrontCm < FRONT_WARN_CM) {
    lM = true; tag = "FRONT_WARN";
  } else if (botUS < BOT_NEAR_CM || drop) {
    lL = true; lR = true;
    tag = (botUS < BOT_NEAR_CM) ? "GROUND_OBSTACLE" : "STAIR_DROPOFF";
  }

  now = millis();
  setMotors(lL || now < motorUntil[0], lM || now < motorUntil[1], lR || now < motorUntil[2]);
  digitalWrite(BUZZER_PIN, buzz ? HIGH : LOW);

  // 5. Phone ko data bhejo
  if (bleConnected) {
    int f = fusedFrontCm >= 400 ? 400 : (int)fusedFrontCm;
    int d = botUS >= 400 ? 400 : (int)botUS;
    char buf[40];
    snprintf(buf, sizeof(buf), "F:%d,D:%d,W:%d,X:%d\n", f, d, drop ? 1 : 0, (now < sosUntil) ? 1 : 0);
    txChar->setValue((uint8_t *)buf, strlen(buf));
    txChar->notify();

    if (gps.location.isValid() && gps.location.age() < 5000 && now - lastGpsSend > 2000) {
      lastGpsSend = now;
      char g[28];
      snprintf(g, sizeof(g), "G:%.5f,%.5f\n", gps.location.lat(), gps.location.lng());
      txChar->setValue((uint8_t *)g, strlen(g));
      txChar->notify();
    }
  }

  Serial.printf("Front:%5.1f (US:%5.1f|ToF:%5.1f) | Ground:%5.1f | IMU:%4.2fg | GPS:%s(%d) | BLE:%s | %s\n",
                fusedFrontCm, frontUS, tofCm, botUS, totalG,
                gps.location.isValid() ? "LOCKED" : "WAIT", gps.satellites.value(),
                bleConnected ? "ON" : "off", tag);

  // ~60 ms wait, lekin is dauran MPU ~100 Hz padhte raho
  for (int i = 0; i < 6; i++) { checkFall(); feedGPS(); delay(10); }
}
