# Auralis

Auralis is a wearable assistant designed to help visually impaired users
detect obstacles and receive directional warnings through vibration,
voice alerts, and a phone-based interface.

## Team

- Shreya — Sensing + Integration
- Sakshi — Connectivity + Voice
- Shriya — Vision + SOS + GPS
- Priyanshi — Phone App + Decision Logic

## Project Architecture

Auralis consists of:

- ESP32 sensor belt
- ToF distance sensing
- Ultrasonic distance sensing
- Fall/drop detection
- Directional vibration
- Bluetooth communication
- Phone-based camera AI
- Voice alerts
- SOS and GPS functionality

## Repository Structure

```text
auralis/
├── firmware/
├── docs/
├── index.html
└── README.md

ESP32 Firmware – Shreya

Firmware file: "firmware/auralis_esp32.ino"

Board: ESP32 Dev Module

Arduino ESP32 Core: 2.0.17

Serial Monitor Baud Rate: 115200

Sensors supported:

- VL53L1X / VL53L0X – Front distance detection
- HC-SR04 – Front obstacle backup
- HC-SR04 – Downward drop detection
- MPU6050 – Fall detection
- NEO-6M GPS – Location tracking

Communication: Bluetooth Low Energy (BLE)

Purpose: Reads sensor data, detects obstacles and drops, and controls vibration motors and buzzer alerts.

Note: Hardware integration and testing are pending.
