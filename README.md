# SME Growth Advisor - Raspberry Pi & TFT Display Edition

An autonomous business intelligence and outbound voice AI operating system designed for **Raspberry Pi**, **TFT Touchscreens (480x320 & fluid mobile)**, and screen-mirroring clients.

Powered by a lightweight Node.js Express architecture on port **3000** with integrated **Bolna Voice AI** outbound telephony, **ElevenLabs Conversational Voice Agent**, and **Gnani AI Speech-to-Text (STT)**.

---

## 🚀 Key Features

* **TFT & Mobile Responsive UI (`dashboard-tft.html`)**: Designed specifically for small TFT touchscreens (3.5" 480x320, 5" / 7" HDMI displays) and mobile screen-mirroring.
* **Push-to-Talk Voice Command Bar**:
  * Tap microphone to speak (e.g., *"call the supplier"*, *"call customer for pending payment"*, *"supplier ko call karo"*).
  * 5-second automatic listening timer with live second ticker and push-to-finish support.
  * Server-side **Gnani AI STT** transcription with automatic mono WAV audio conversion via `ffmpeg-static` and browser Web Speech fallback.
  * Code-mixed Hindi / Hinglish and English intent parser.
* **Bolna Voice AI Outbound Telephony**:
  * **Supplier Intelligence Agent (Aarav)**: Instant automated supplier quotation calls (`4ee43af0-7773-487b-9262-2710f68311f8`).
  * **Collections Agent (Meera)**: Automated payment follow-up calls to overdue accounts (`28712767-d9a9-4c6a-b7ed-6481d0357c16`).
  * Real-time in-call timer, audio equalizer, and execution polling.
* **ElevenLabs Conversational Voice Partner**:
  * **AI Advisor (Kavya / Vyapaar AI)**: Live conversational audio briefing embed (`agent_1901m4kqdmycfkn9pra87mp8jmtd`) with 1-tap direct session launch.
* **Raspberry Pi Kiosk Optimized**:
  * Direct root serving (`/` and `/dashboard-tft.html`).
  * Cache-busting HTTP headers (`no-cache, no-store, must-revalidate`) preventing stale UI on reboot.

---

## 🛠️ Quick Start Guide

### 1. Prerequisites
* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher

### 2. Clone & Install
```bash
git clone https://github.com/Kartikey-varshney206/SME-RASPBERRY-PI.git
cd SME-RASPBERRY-PI
npm install
```

### 3. Configure Environment Variables
Copy the sample environment file and configure your API keys:
```bash
cp .env.example .env
```
Open `.env` in any text editor and fill in your keys:
```env
PORT=3000

# Bolna Voice AI Outbound Telephony
BOLNA_API_KEY=your_bolna_api_key_here
BOLNA_SUPPLIER_AGENT_ID=4ee43af0-7773-487b-9262-2710f68311f8
BOLNA_COLLECTIONS_AGENT_ID=28712767-d9a9-4c6a-b7ed-6481d0357c16

# Gnani AI STT Key
GNANI_API_KEY=your_gnani_stt_key_here

# Test Mode & Phone Number
TEST_MODE=true
TEST_PHONE_NUMBER=+916363077110
BYPASS_RATE_LIMIT=true
```

### 4. Start the Server
```bash
npm start
```
The server will start on port **3000**:
```
========================================================
 SME Growth Advisor - Voice Telephony Server Active
 Running on: http://localhost:3000
 TFT UI URL: http://localhost:3000/dashboard-tft.html
 Test Mode : ENABLED (Calls to +916363077110)
========================================================
```

---

## 🖥️ Accessing on Raspberry Pi / Phone

* **On the Raspberry Pi**:
  ```
  http://localhost:3000
  ```
* **On any phone or device on the same Wi-Fi / hotspot**:
  ```
  http://<RASPBERRY_PI_IP>:3000
  ```

---

## 📂 Repository Structure

```
├── dashboard-tft.html        # Main TFT & Mobile Dashboard application
├── server.js                 # Express server & API gateway (port 3000)
├── package.json              # Project dependencies & scripts
├── suppliers.json            # Active suppliers database
├── customers.json            # Overdue receivables database
├── kpis.json                 # Business health score metrics
├── *.csv                     # Business datasets (invoices, inventory, etc.)
├── .env.example              # Sample environment configuration
└── .gitignore                # Production ignore rules (blocks secrets & logs)
```

---

## 📄 License
ISC
