// Auralis ESP32 firmware v3
// Sensors: VL53L1X (front) + HC-SR04 #2 (front backup) + HC-SR04 #1 (down)
//          + MPU6050 (fall) + NEO-6M GPS (location)
// Board: ESP32 Dev Module | Core: esp32 by Espressif 2.0.17 | Serial Monitor: 115200
// Libraries (Library Manager): "VL53L1X" by Pololu, "Adafruit MPU6050",
//           "Adafruit Unified Sensor", "TinyGPSPlus" by Mikal Hart

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ===== SWITCHES (1 = on, 0 = off) =====
#define FAKE_DATA  1  // 1 = nakli distance bhejo (sensor ke bina BLE test)
#define USE_TOF    0  // 1 = VL53L1X/VL53L0X laga hai, 0 = nahi laga
#define TOF_IS_L0X 0  // 1 = tumhare paas asli chip VL53L0X hai, 0 = VL53L1X
#define USE_MPU    0  // 1 = MPU6050 laga hai (fall detection), 0 = nahi laga
#define USE_GPS    0  // 1 = NEO-6M GPS laga hai, 0 = nahi laga

#if USE_TOF
#if TOF_IS_L0X
#include <VL53L0X.h>
VL53L0X tof;          // Pololu VL53L0X
#else
#include <VL53L1X.h>
VL53L1X tof;          // Pololu VL53L1X
#endif
#endif

#if USE_GPS
#include <TinyGPSPlus.h>
TinyGPSPlus gps;
#endif

#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // phone -> ESP32
#define TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 -> phone

// ===== PINS =====
const int SDA_PIN = 21, SCL_PIN = 22;     // VL53L1X + MPU6050 (dono isi I2C bus par)
const int TRIG_D = 5,   ECHO_D = 18;      // HC-SR04 #1: neeche (drop), ECHO divider ke baad
const int TRIG_F = 19,  ECHO_F = 32;      // HC-SR04 #2: aage (backup), ECHO divider ke baad
const int MOTOR[3] = {25, 26, 27};        // Left, Centre, Right (2N2222 ke through)
const int BUZZER = 23;                    // 2N2222 ke through
const int BUTTON = 4;                     // GND se jodo, INPUT_PULLUP
const int GPS_RX = 16,  GPS_TX = 17;      // GPS ka TX -> D16 (ESP32 RX2). GPS ka RX zaroori nahi

// ===== SETTINGS (yahi tune karna) =====
const int FRONT_LIMIT_CM = 50;            // isse paas = bina phone ke centre motor
const int DROP_MARGIN_CM = 25;            // baseline se itna zyada = drop
const float FALL_IMPACT_MS2 = 25.0;       // ~2.5 g ka jhatka
const unsigned long PHONE_VIBRATE_MS = 600;

BLECharacteristic *txChar;
bool connected = false;
bool tofOk = false, mpuOk = false;
Adafruit_MPU6050 mpu;
unsigned long motorUntil[3] = {0, 0, 0};
int dropBaseline = 30;
unsigned long lastGpsSend = 0;
unsigned long impactAt = 0, fallUntil = 0, sosUntil = 0, btnDownAt = 0;

// ===== SHREYA KA HISSA: sensor padhna =====
int readCm(int trig, int echo) { // HC-SR04
  digitalWrite(trig, LOW); delayMicroseconds(2);
  digitalWrite(trig, HIGH); delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long d = pulseIn(echo, HIGH, 25000); // 25 ms timeout
  if (d == 0) return 400;              // echo nahi aaya
  int cm = (int)(d * 0.0343 / 2.0);
  return cm > 400 ? 400 : cm;
}

int readMedian(int trig, int echo) {   // 3 reading ka median = kam noise
  int a = readCm(trig, echo); delay(8);
  int b = readCm(trig, echo); delay(8);
  int c = readCm(trig, echo);
  if (a > b) { int t = a; a = b; b = t; }
  if (b > c) { int t = b; b = c; c = t; }
  if (a > b) { int t = a; a = b; b = t; }
  return b;
}

int readTofCm() {
#if USE_TOF
  if (!tofOk) return 400;
#if TOF_IS_L0X
  int mm = tof.readRangeContinuousMillimeters();
#else
  int mm = tof.read();
#endif
  if (tof.timeoutOccurred() || mm <= 0 || mm > 4000) return 400;
  int cm = mm / 10;
  return cm > 400 ? 400 : cm;
#else
  return 400;
#endif
}

void feedGps() {
#if USE_GPS
  // GPS ke NMEA bytes padho
  while (Serial2.available()) gps.encode(Serial2.read());
#endif
}

void beep(int ms) { digitalWrite(BUZZER, HIGH); delay(ms); digitalWrite(BUZZER, LOW); }

void calibrateDrop() {
  dropBaseline = readMedian(TRIG_D, ECHO_D);
  Serial.printf("Drop baseline = %d cm\n", dropBaseline);
  beep(150);
}

// ===== SAKSHI KA HISSA: fall detection (MPU6050) =====
void updateFall() {
  if (!mpuOk) return;
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  float mag = sqrt(a.acceleration.x * a.acceleration.x +
                   a.acceleration.y * a.acceleration.y +
                   a.acceleration.z * a.acceleration.z);
  unsigned long now = millis();
  if (impactAt == 0 && mag > FALL_IMPACT_MS2) impactAt = now; // jhatka mila
  if (impactAt != 0 && now - impactAt > 1000) {               // 1 sec baad
    if (fabs(mag - 9.8) < 2.0) {                              // rest par ~9.8 = ab sthir gir gaya
      fallUntil = now + 5000;
      Serial.println("FALL detected");
    }
    impactAt = 0;
  }
}

// ===== SAKSHI KA HISSA: BLE =====
// Phone (ya Serial Monitor) se aaya ek letter: L, C, R ya A (all)
void handleCmd(char ch) {
  unsigned long until = millis() + PHONE_VIBRATE_MS;
  if (ch == 'L') motorUntil[0] = until;
  else if (ch == 'C') motorUntil[1] = until;
  else if (ch == 'R') motorUntil[2] = until;
  else if (ch == 'A') { motorUntil[0] = motorUntil[1] = motorUntil[2] = until; }
  else return;
  Serial.printf("Command: %c\n", ch);
}

class ServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer *s) {
    connected = true;
    Serial.println("BLE connected");
  }
  void onDisconnect(BLEServer *s) {
    connected = false;
    Serial.println("BLE disconnected");
    BLEDevice::startAdvertising();
  }
};

class RxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) {
    auto v = c->getValue(); // phone se aaya text
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

// ===== MAIN =====
void setup() {
  Serial.begin(115200);
  pinMode(TRIG_D, OUTPUT); pinMode(ECHO_D, INPUT);
  pinMode(TRIG_F, OUTPUT); pinMode(ECHO_F, INPUT);
  for (int i = 0; i < 3; i++) { pinMode(MOTOR[i], OUTPUT); digitalWrite(MOTOR[i], LOW); }
  pinMode(BUZZER, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);

#if USE_GPS
  Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX); // NEO-6M default 9600 baud
#endif

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);

#if USE_TOF
  tof.setTimeout(200);
  tofOk = tof.init();
  if (tofOk) {
#if TOF_IS_L0X
    tof.startContinuous(50);
#else
    tof.setDistanceMode(VL53L1X::Long);
    tof.setMeasurementTimingBudget(50000);
    tof.startContinuous(50);
#endif
  }
  Serial.println(tofOk ? "ToF OK" : "ToF NOT found (wiring check karo)");
#endif

#if USE_MPU
  mpuOk = mpu.begin();
  if (mpuOk) mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  Serial.println(mpuOk ? "MPU6050 OK" : "MPU6050 NOT found (wiring check karo)");
#endif

  setupBle();
  delay(1500);     // sensor ko stable hone do
  calibrateDrop(); // belt seedhi pakad ke boot karo
}

void loop() {
  int fToF = 0, fUs = 0, f, d;
  feedGps();

#if FAKE_DATA
  static int fake = 200;
  fake -= 10; if (fake < 20) fake = 200;
  f = fake; d = dropBaseline;
#else
  fToF = readTofCm();
  fUs = readCm(TRIG_F, ECHO_F);
  f = (fToF < fUs) ? fToF : fUs; // dono mein se jo paas dikhaye
  delay(20);                     // sensors ek saath na bolen
  d = readCm(TRIG_D, ECHO_D);
#endif

  bool obstacle = (f < FRONT_LIMIT_CM);
  bool drop = (d > dropBaseline + DROP_MARGIN_CM);

  unsigned long now = millis();
  bool fall = (now < fallUntil);
  bool sos = (now < sosUntil);

  if (drop) { // sabse zaroori warning
    for (int i = 0; i < 3; i++) digitalWrite(MOTOR[i], HIGH);
    digitalWrite(BUZZER, HIGH);
  } else {
    digitalWrite(BUZZER, (fall || sos) ? HIGH : LOW);
    for (int i = 0; i < 3; i++) {
      bool fromPhone = now < motorUntil[i];
      bool fallback = (i == 1 && obstacle); // bina phone ke bhi centre motor
      digitalWrite(MOTOR[i], (fromPhone || fallback) ? HIGH : LOW);
    }
  }

  while (Serial.available()) handleCmd(Serial.read()); // Serial Monitor se L/C/R test

  // Button: chhota dabao = SOS, 2 sec dabaye rakho = drop baseline dobara
  bool down = (digitalRead(BUTTON) == LOW);
  if (down && btnDownAt == 0) btnDownAt = now;
  if (!down && btnDownAt != 0) {
    unsigned long held = now - btnDownAt;
    btnDownAt = 0;
    if (held >= 2000) calibrateDrop();
    else if (held >= 50) { sosUntil = now + 5000; Serial.println("SOS pressed"); }
  }

  if (connected) {
    char buf[40];
    snprintf(buf, sizeof(buf), "F:%d,D:%d,W:%d,X:%d\n", f, d, drop ? 1 : 0, (fall || sos) ? 1 : 0);
    txChar->setValue((uint8_t *)buf, strlen(buf));
    txChar->notify();

#if USE_GPS
    // Location line (max 20 bytes): G:28.61234,77.20901 - sirf jab fix ho, har 2 sec
    if (gps.location.isValid() && gps.location.age() < 5000 && now - lastGpsSend > 2000) {
      lastGpsSend = now;
      char g[28];
      snprintf(g, sizeof(g), "G:%.5f,%.5f\n", gps.location.lat(), gps.location.lng());
      txChar->setValue((uint8_t *)g, strlen(g));
      txChar->notify();
    }
#endif
  }

#if USE_GPS
  Serial.printf("F=%d (tof=%d us=%d) D=%d base=%d drop=%d fall=%d sos=%d gps=%s sats=%d\n",
                f, fToF, fUs, d, dropBaseline, drop, fall, sos,
                gps.location.isValid() ? "FIX" : "no-fix",
                (int)gps.satellites.value());
#else
  Serial.printf("F=%d (tof=%d us=%d) D=%d base=%d drop=%d fall=%d sos=%d\n",
                f, fToF, fUs, d, dropBaseline, drop, fall, sos);
#endif

  for (int i = 0; i < 8; i++) { updateFall(); feedGps(); delay(10); } // MPU ko ~100 Hz par padho
}
