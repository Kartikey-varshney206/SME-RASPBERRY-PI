# SME Growth Advisor - Voice Telephony & Screen-Mirror Edition

An AI-powered Business Operating System for SMEs with hands-free voice command telephony, real-time KPI tracking, and automated outbound calling via **Bolna Voice AI** and **ElevenLabs Conversational AI**.

Designed for dual deployment:
1. **Laptop Screen** (Full-screen fluid responsive layout).
2. **Raspberry Pi 3.5-inch TFT Display (480x320 landscape)** running in Chromium kiosk touch mode with zero mouse/keyboard required.

---

## 🎙️ Voice Command Feature (Home Page with Gnani STT)

The dashboard home page includes a push-to-talk voice copilot powered by the **Gnani AI Speech-to-Text REST API** (`https://api.vachana.ai/stt/v3`) using model `prisma-v3.0` with `indic-auto` automatic language detection and code-mixed speech recognition.

### Supported Voice Commands (English + Hindi / Hinglish)
| Goal | Spoken Variations (English & Hindi/Hinglish) | Action Triggered |
|------|----------------------------------------------|------------------|
| **Call Supplier** | *"supplier ko call karo"*, *"call the supplier"*, *"supplier ko phone lagao"*, *"phone the supplier"*, *"vendor ko call karo"* | Dispatches outbound call to **Sharma Traders** (Supplier) using Bolna Agent Aarav (`4ee43af0-7773-487b-9262-2710f68311f8`) |
| **Call Overdue Customer** | *"call the customer for pending payment"*, *"customer ko call karo"*, *"baaki paisa collect karo"*, *"pending payment ke liye call karo"*, *"collect payment"*, *"paisa collect karo"* | Dispatches outbound call to **Ramesh Kumar** (₹42,000 pending, 45d overdue) using Bolna Agent Meera (`28712767-d9a9-4c6a-b7ed-6481d0357c16`) |
| **Voice Confirm** | *"yes"*, *"confirm"*, *"proceed"*, *"haan"*, *"ha"*, *"theek hai"*, *"karo"*, *"lagao"* | Confirms the pending call and initiates dialing |
| **Voice Cancel** | *"no"*, *"cancel"*, *"stop"*, *"nahi"*, *"na"*, *"mat karo"*, *"ruko"* | Closes the confirm modal and aborts the call |

---

## 📁 File Structure

```text
├── server.js               # Node.js + Express backend (localhost:3000) with Gnani STT, Bolna & Ledger
├── package.json            # Node.js dependencies (exceljs, express, cors, etc.)
├── .env                    # Secret API keys (GNANI_API_KEY, BOLNA_API_KEY, etc.)
├── .env.example            # Environment template
├── dashboard-tft.html      # Responsive 480x320 TFT & Laptop dashboard with ElevenLabs widget & voice bookkeeping
├── index.html              # Desktop dashboard with small-screen auto-redirect
├── suppliers.json          # Mock suppliers directory (Sharma Traders primary supplier)
├── customers.json          # Mock customers queue (Ramesh Kumar highest overdue)
├── data/
│   ├── ledger.xlsx         # Excel ledger with 'Customers' and 'Ledger' sheets
│   └── backups/            # Automatic timestamped backups created before every write
├── ledger.log              # Persistent log of all voice bookkeeping transactions & undo actions
├── calls.log               # Persistent log of all outbound call dispatches
├── api.py                  # Python FastAPI backend (interoperable alternative on 8080)
└── logo.png                # Dashboard brand logo
```

---

## 🎙️ Voice Bookkeeping with ElevenLabs (`record_transaction`)

The dashboard features real-time voice bookkeeping integrated directly into the **ElevenLabs Conversational AI widget** (`<elevenlabs-convai>`). You speak natural entries, the agent invokes the client tool `record_transaction`, and the backend updates `data/ledger.xlsx`.

### Example Spoken Voice Entries
- *"Sharma borrowed 2k today"* -> Triggers `record_transaction` with `{ customer_name: "Sharma", type: "credit_given", amount: 2000 }`.
- *"Anuj did not pay 5k"* -> Triggers `record_transaction` with `{ customer_name: "Anuj", type: "payment_missed", amount: 5000 }`.
- *"Aman paid me 7k"* -> Triggers `record_transaction` with `{ customer_name: "Aman", type: "payment_received", amount: 7000 }`.

### Excel Ledger Structure (`data/ledger.xlsx`)
1. **Sheet `Customers`**:
   - `Name` | `Phone` | `Balance`
   - Initial sample customers: Sharma (₹15,000), Anuj (₹8,000), Aman (₹22,000).
2. **Sheet `Ledger`**:
   - `Date` | `Customer` | `Type` | `Amount` | `Note` | `Source`
   - Every transaction appends a new audit row with `Source = "voice"`.

### Business Logic
- **`credit_given`**: `Balance += amount`. Automatically creates a new customer row if not found.
- **`payment_received`**: `Balance -= amount`. Balance will never drop below 0; warns if `amount > balance`.
- **`payment_missed`**: Balance unchanged; an entry is logged in the `Ledger` sheet.
- **Sequential Queue**: Operations are serialized via a Promise queue so multiple rapid entries do not corrupt the Excel file.
- **Automatic Backups**: `data/backups/ledger_backup_*.xlsx` is saved before every mutation.
- **Undo Capability**: Tap the touch-friendly (44px+) **UNDO LAST ENTRY** button to revert the latest transaction and recalculate the customer's balance.

### ElevenLabs Agent Client Tool Setup
In your [ElevenLabs Conversational AI Agent Console](https://elevenlabs.io/app/conversational-ai):
1. Navigate to your Agent (`agent_1901m4kqdmycfkn9pra87mp8jmtd`).
2. Go to **Tools** -> **Add Tool** -> Select **Client Tool**.
3. Set **Tool Name**: `record_transaction` (exact match, case-sensitive).
4. Set **Description**: *"Record financial transactions, credits given, payments received, or missed payments into the SME ledger."*
5. Add **Parameters**:
   - `customer_name` (string, required): Customer or party name (e.g. "Sharma", "Anuj").
   - `type` (string, required, enum: `credit_given`, `payment_received`, `payment_missed`): Type of transaction.
   - `amount` (number, required): Transaction amount in INR (positive number).
   - `date` (string, optional): Date of transaction (YYYY-MM-DD or standard format).
   - `note` (string, optional): Context or description.

### How to Test the Bookkeeping Feature
1. Open the dashboard at [http://localhost:3000/dashboard-tft.html](http://localhost:3000/dashboard-tft.html).
2. Look at the bottom right ElevenLabs floating button or tap the ElevenLabs widget to start a voice conversation.
3. Speak: *"Record credit of 2000 for Sharma"* or *"Sharma borrowed 2k today"*.
4. **Expected Results**:
   - A green toast appears on screen: **"Saved: Sharma (+₹2,000)"**.
   - The "Recent Voice Bookkeeping Entries" panel lists the new entry at the top.
   - The **Pending Receivables** card updates immediately from ₹45,000 to ₹47,000 without reloading the page.
   - Open `data/ledger.xlsx` to verify that Sharma's Balance is now `17000` and a new row exists in the `Ledger` sheet.
   - Tap **"↩️ UNDO LAST ENTRY"** to reverse the transaction. Toast displays **"Undone: credit_given for Sharma (₹2,000)"** and the balance returns to ₹45,000.

### What to Check if Nothing Updates (Troubleshooting)
1. **Check Browser Console (`F12` -> Console)**:
   - Look for `[ElevenLabs ConvAI Call Event] Client tools attached`. If absent, verify network connectivity to `elevenlabs.io`.
   - When speaking, check for `[ClientTool] record_transaction triggered with: ...`.
2. **Check `ledger.log`**:
   - Every call to `/api/ledger` and `/api/ledger/undo` logs its payload and outcome in `d:\SME website main - Copy\ledger.log`.
3. **Verify Agent Tool Name**:
   - Ensure the tool name in the ElevenLabs console is exactly `record_transaction` with matching parameter keys (`customer_name`, `type`, `amount`).
4. **Verify Excel File**:
   - Ensure `data/ledger.xlsx` is not locked by Microsoft Excel in exclusive write mode. The backend creates timestamped backups in `data/backups/`.
5. **Backend Server Status**:
   - Ensure `server.js` is running on port 3000 (`node server.js`). Test endpoint manually:
     ```bash
     curl -X GET http://localhost:3000/api/summary
     ```
     Should return: `{"ok":true,"total_pending":...,"customer_count":...}`

---

## 🚀 Quick Start (Node.js + Express)

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```
The server will boot on `http://localhost:3000`.

### 3. Open the Dashboard
- **TFT & Laptop Screen-Mirror**: [http://localhost:3000/dashboard-tft.html](http://localhost:3000/dashboard-tft.html)
- **Desktop Entry**: [http://localhost:3000/](http://localhost:3000/)

---

## ⚡ Voice Recognition via Gnani STT (`STT_MODE = "server"`)

The dashboard is configured with **`STT_MODE = "server"`** by default:

1. Tap the big round **Mic Button** on the Home Page.
2. Speak any English or Hindi/Hinglish command (e.g. *"supplier ko call karo"* or *"call the customer for pending payment"*).
   - Audio is captured via `MediaRecorder` (max 10 seconds, auto-stops after 1.8 seconds of silence).
   - Audio buffer is converted to standard 16kHz mono WAV via `ffmpeg` as required by Gnani API.
   - Forwarded to `POST https://api.vachana.ai/stt/v3` with header `X-API-Key-ID: ${GNANI_API_KEY}`.
3. The recognized text displays live in the caption bar.
4. The large **Confirm Card** appears:
   - For supplier: *"Call Sharma Traders (Supplier)?"*
   - For customer: *"Call Ramesh Kumar - ₹42,000 pending?"*
5. Speak *"haan"* / *"yes"* or tap **"✅ Yes, Call Now"** to trigger the Bolna outbound call.
6. To use native browser speech recognition on laptop, tap the `[Gnani STT ⚡]` pill to toggle to `[Browser STT 🌐]`.
7. Errors (network failure, empty audio, invalid key) trigger a spoken *"Sorry, I didn't catch that."*

---

## 🛡️ Safety & Safeguards

1. **Explicit Confirmation**: Every call requires confirmation via touch button or vocal *"yes"*. The system never dials unconfirmed calls.
2. **Rate Limiting**: Max **1 call per phone number per hour**. Repeated calls within 60 minutes are blocked with a countdown message (bypassable for dev testing via `BYPASS_RATE_LIMIT=true` in `.env`).
3. **Business Hours Enforcement**: Outbound calls can be restricted to **9:00 AM – 7:00 PM** (`CALL_WINDOW_START_HOUR=9`, `CALL_WINDOW_END_HOUR=19`, `CALL_WINDOW_ENFORCE=true`).
4. **Test Mode Sandbox**: When `TEST_MODE=true`, all calls are routed strictly to your verified test number (`+916363077110`), preventing accidental calls to real suppliers or customers.
5. **Call Audit Logging**: Every outbound call attempt is appended to `calls.log` with timestamp, action, phone number, callee name, status, and Bolna execution ID.
6. **No API Keys in Frontend**: Client-side code only communicates with `/api/voice-command` and `/api/call/bolna`. All private Bolna and OpenAI keys remain in `.env`.

---

## 🖥️ Raspberry Pi Kiosk Setup (Chromium on 3.5" TFT)

### 1. Chromium Kiosk Command
Run Chromium without toolbars, error bars, or scrollbars:
```bash
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --incognito \
  --check-for-update-interval=31536000 \
  --touch-events=enabled \
  --enable-features=OverlayScrollbar \
  --use-fake-ui-for-media-stream \
  http://localhost:3000/dashboard-tft.html
```
> `--use-fake-ui-for-media-stream` auto-grants microphone permissions so Chromium never prompts for mic access in kiosk mode.

### 2. Auto-Start on Boot (`/etc/xdg/autostart/sme-kiosk.desktop`)
```ini
[Desktop Entry]
Type=Application
Name=SME Growth Advisor Kiosk
Exec=/home/pi/start-kiosk.sh
X-GNOME-Autostart-enabled=true
```

In `/home/pi/start-kiosk.sh`:
```bash
#!/bin/bash
# 1. Hide mouse cursor
unclutter -idle 0.1 -root &

# 2. Disable screen sleep
xset s off
xset -dpms
xset s noblank

# 3. Start Node.js backend
cd "/home/pi/SME website main - Copy"
npm start &

# 4. Wait for server and launch Chromium
sleep 3
chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito --use-fake-ui-for-media-stream http://localhost:3000/dashboard-tft.html
```
Make executable: `chmod +x /home/pi/start-kiosk.sh`

### 3. Hide Cursor & Disable Screen Blanking
```bash
sudo apt-get install -y unclutter x11-xserver-utils
```

### 4. 3.5" TFT Screen Setup & Calibration
For standard GPIO 3.5" SPI LCD displays:
```bash
git clone https://github.com/goodtft/LCD-show.git
chmod -R 755 LCD-show
cd LCD-show/
sudo ./LCD35-show 90
```
For touch calibration:
```bash
sudo apt-get install -y xinput-calibrator
xinput_calibrator
```

### 5. Audio Output & Input
- **Microphone**: Plug in a mini USB microphone or USB conference mic. Set default ALSA input:
  ```bash
  arecord -l   # find card index (e.g., card 1)
  ```
- **Speaker**: Connect a 3.5mm speaker or USB audio speaker. Set default output via `alsamixer` or `raspi-config` -> System Options -> Audio.
