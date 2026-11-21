const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const multer = require('multer');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static') || 'ffmpeg';

// Load environment configuration
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer memory storage for audio transcription uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25 MB max
});

// Paths to data and logs
const CALLS_LOG_PATH = path.join(__dirname, 'calls.log');
const SUPPLIERS_PATH = path.join(__dirname, 'suppliers.json');
const CUSTOMERS_PATH = path.join(__dirname, 'customers.json');

// Ensure calls.log exists
if (!fs.existsSync(CALLS_LOG_PATH)) {
    fs.writeFileSync(CALLS_LOG_PATH, `[${new Date().toISOString()}] LOG_INIT: Call logging service initialized.\n`, 'utf8');
}

// In-memory rate limiting map: { phoneNumber: timestamp }
const lastCallByPhone = {};

// Helper: Append log to calls.log
function logCall(action, phoneNumber, calleeName, agentId, status, executionId, details = '') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ACTION: ${action} | TO: ${phoneNumber} (${calleeName}) | AGENT: ${agentId} | STATUS: ${status} | EXEC_ID: ${executionId || 'none'} ${details ? '| ' + details : ''}\n`;
    try {
        fs.appendFileSync(CALLS_LOG_PATH, logEntry, 'utf8');
        console.log(`[CALL_LOG] ${logEntry.trim()}`);
    } catch (err) {
        console.error('Error writing to calls.log:', err.message);
    }
}

// Helper: Load JSON file safely
function loadJsonData(filePath, fallback = []) {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        }
    } catch (err) {
        console.error(`Error loading JSON from ${filePath}:`, err.message);
    }
    return fallback;
}

// Helper: Format phone to international E.164
function formatE164(phone) {
    if (!phone) return '+916363077110';
    let cleaned = phone.replace(/[^0-9+]/g, '');
    if (!cleaned.startsWith('+')) {
        if (cleaned.length === 10) cleaned = '+91' + cleaned;
        else if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = '+' + cleaned;
        else cleaned = '+' + cleaned;
    }
    return cleaned;
}

// Helper: Convert audio buffer (WebM / OGG / etc.) to 16kHz mono WAV using ffmpeg if needed
function ensureWavBuffer(inputBuffer, mimetype = '') {
    if (!inputBuffer || inputBuffer.length === 0) return inputBuffer;

    // Check if incoming buffer already has RIFF WAVE header
    if (inputBuffer.length >= 12 &&
        inputBuffer.toString('ascii', 0, 4) === 'RIFF' &&
        inputBuffer.toString('ascii', 8, 12) === 'WAVE') {
        return inputBuffer;
    }

    try {
        const inExt = mimetype.includes('ogg') ? '.ogg' : (mimetype.includes('mp3') ? '.mp3' : '.webm');
        const tempIn = path.join(os.tmpdir(), `gnani_in_${Date.now()}_${Math.random().toString(36).substring(7)}${inExt}`);
        const tempOut = path.join(os.tmpdir(), `gnani_out_${Date.now()}_${Math.random().toString(36).substring(7)}.wav`);

        fs.writeFileSync(tempIn, inputBuffer);

        const res = spawnSync(ffmpegPath, [
            '-y',
            '-i', tempIn,
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            tempOut
        ], { timeout: 15000 });

        if (res.error || res.status !== 0) {
            console.warn('[FFMPEG Warning] Could not convert audio with ffmpeg, passing raw buffer:', res.error?.message || res.stderr?.toString());
            try { fs.unlinkSync(tempIn); } catch (e) {}
            return inputBuffer;
        }

        const wavData = fs.readFileSync(tempOut);
        try { fs.unlinkSync(tempIn); } catch (e) {}
        try { fs.unlinkSync(tempOut); } catch (e) {}
        return wavData;
    } catch (convErr) {
        console.warn('[Audio Conversion Warning]', convErr.message);
        return inputBuffer;
    }
}

// =============================================================================
// API 1: SPEECH-TO-TEXT TRANSCRIBE (POST /api/transcribe) - GNANI AI STT v3
// =============================================================================
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No audio file uploaded.', text: '' });
        }

        console.log(`[STT] Received audio buffer: ${req.file.size} bytes (${req.file.mimetype})`);

        const gnaniKey = (process.env.GNANI_API_KEY || '').trim();

        // 1. PRIMARY: Gnani AI Speech-to-Text REST API
        // Endpoint: POST https://api.vachana.ai/stt/v3
        // Header: X-API-Key-ID: ${GNANI_API_KEY}
        // Supported Formats: wav, ogg, aac, m4a, mp3, flac (converted to 16kHz mono WAV via ffmpeg)
        // Supported Language Codes: indic-auto, hi-IN, en-IN, etc.
        // Model: prisma-v3.0 (multilingual, automatic language & Hinglish code-mix support)
        if (gnaniKey && !gnaniKey.startsWith('your_')) {
            try {
                // Ensure audio is converted to standard 16kHz mono WAV as required by Gnani docs
                const wavBuffer = ensureWavBuffer(req.file.buffer, req.file.mimetype);

                const FormData = require('form-data');
                const form = new FormData();
                form.append('audio_file', wavBuffer, {
                    filename: 'recording.wav',
                    contentType: 'audio/wav'
                });
                form.append('model', 'prisma-v3.0');
                form.append('language_code', 'indic-auto'); // Hindi / English / Code-mixed Hinglish auto-detection
                form.append('format', 'transcribe');

                const gnaniResp = await axios.post('https://api.vachana.ai/stt/v3', form, {
                    headers: {
                        'X-API-Key-ID': gnaniKey,
                        ...form.getHeaders()
                    },
                    timeout: 25000
                });

                const data = gnaniResp.data || {};
                const transcript = (data.transcript || '').trim();
                console.log(`[STT Gnani] Transcribed: "${transcript}" (Lang: ${data.detected_language_code || 'indic-auto'}, Model: ${data.model || 'prisma-v3.0'})`);

                return res.json({
                    success: true,
                    text: transcript,
                    provider: 'gnani',
                    detected_language: data.detected_language_code || 'indic-auto',
                    request_id: data.request_id || ''
                });

            } catch (gErr) {
                const errMsg = gErr.response?.data?.error?.message || gErr.response?.data?.message || gErr.message;
                const errStatus = gErr.response?.status || 502;
                console.error('[STT Gnani Error]', errStatus, errMsg);

                return res.status(errStatus).json({
                    success: false,
                    error: `Gnani STT error: ${errMsg}`,
                    text: ''
                });
            }
        }

        // 2. Fallback to OpenAI Whisper if OPENAI_API_KEY is configured
        const openAiKey = (process.env.OPENAI_API_KEY || '').trim();
        if (openAiKey && !openAiKey.startsWith('your_')) {
            try {
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', req.file.buffer, {
                    filename: 'recording.webm',
                    contentType: req.file.mimetype || 'audio/webm'
                });
                form.append('model', 'whisper-1');

                const whisperResp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
                    headers: {
                        'Authorization': `Bearer ${openAiKey}`,
                        ...form.getHeaders()
                    },
                    timeout: 25000
                });

                const transcript = (whisperResp.data?.text || '').trim();
                return res.json({ success: true, text: transcript, provider: 'openai-whisper' });
            } catch (wErr) {
                console.error('[STT Whisper Error]', wErr.message);
            }
        }

        console.warn('[STT] GNANI_API_KEY not found in .env');
        return res.status(401).json({
            success: false,
            error: 'GNANI_API_KEY not configured in .env',
            text: ''
        });

    } catch (err) {
        console.error('[STT Server Error]', err);
        return res.status(500).json({ success: false, error: 'Audio processing error: ' + err.message, text: '' });
    }
});

// =============================================================================
// API 2: VOICE COMMAND OUTBOUND CALL (POST /api/voice-command)
// =============================================================================
app.post('/api/voice-command', async (req, res) => {
    try {
        const { action } = req.body;
        if (!action || !['call_supplier', 'call_pending_customer'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: "Invalid action. Supported actions: 'call_supplier' or 'call_pending_customer'."
            });
        }

        // ---------------------------------------------------------------------
        // SAFETY CHECK 1: BUSINESS HOURS WINDOW (9 AM - 7 PM)
        // ---------------------------------------------------------------------
        const enforceWindow = process.env.CALL_WINDOW_ENFORCE === 'true';
        const startHour = parseInt(process.env.CALL_WINDOW_START_HOUR || '9', 10);
        const endHour = parseInt(process.env.CALL_WINDOW_END_HOUR || '19', 10);
        const currentHour = new Date().getHours();

        if (enforceWindow && (currentHour < startHour || currentHour >= endHour)) {
            const timeMsg = `Calls are restricted to business hours (${startHour}:00 AM to ${endHour > 12 ? endHour - 12 : endHour}:00 PM). Current server hour: ${currentHour}:00.`;
            logCall(action, 'N/A', 'N/A', 'N/A', 'blocked_outside_hours', null, timeMsg);
            return res.status(403).json({ success: false, error: timeMsg });
        }

        // ---------------------------------------------------------------------
        // TARGET LOOKUP FROM DATA FILES
        // ---------------------------------------------------------------------
        let target = null;
        let agentId = '';
        const bolnaKey = (process.env.BOLNA_API_KEY || '').trim();

        if (action === 'call_supplier') {
            const suppliers = loadJsonData(SUPPLIERS_PATH, [
                { id: "SUP001", name: "Sharma Traders", contactPerson: "Ramesh Sharma", phone: "+916363077110", category: "Raw Materials", isPrimary: true },
                { id: "SUP027", name: "Devi and Sons", contactPerson: "Leela Dua", phone: "+916363077110", category: "Kitchen Gadgets" }
            ]);
            // Pick primary supplier or first supplier
            target = suppliers.find(s => s.isPrimary) || suppliers[0];
            agentId = process.env.BOLNA_SUPPLIER_AGENT_ID || process.env.BOLNA_AGENT_ID_SUPPLIER || '4ee43af0-7773-487b-9262-2710f68311f8';
        } else if (action === 'call_pending_customer') {
            const customers = loadJsonData(CUSTOMERS_PATH, [
                { id: "CUST001", name: "Ramesh Kumar", phone: "+916363077110", amountPending: 42000, daysOverdue: 45, invoiceId: "INV00892" },
                { id: "CUST0445", name: "Tejas Sem", phone: "+916363077110", amountPending: 206590.32, daysOverdue: 30, invoiceId: "INV00145" }
            ]);
            // Pick customer with the most overdue payment (highest days overdue or highest amount)
            const sorted = [...customers].sort((a, b) => {
                const daysDiff = (b.daysOverdue || 0) - (a.daysOverdue || 0);
                if (daysDiff !== 0) return daysDiff;
                return (b.amountPending || 0) - (a.amountPending || 0);
            });
            target = sorted[0];
            agentId = process.env.BOLNA_COLLECTIONS_AGENT_ID || process.env.BOLNA_AGENT_ID_PAYMENT || '28712767-d9a9-4c6a-b7ed-6481d0357c16';
        }

        if (!target) {
            return res.status(404).json({ success: false, error: 'Target recipient not found in data directory.' });
        }

        // ---------------------------------------------------------------------
        // PHONE NUMBER & TEST MODE HANDLING
        // ---------------------------------------------------------------------
        const isTestMode = process.env.TEST_MODE === 'true';
        const testPhone = process.env.TEST_PHONE_NUMBER || '+916363077110';
        let destinationPhone = formatE164(isTestMode ? testPhone : (target.phone || testPhone));

        // ---------------------------------------------------------------------
        // SAFETY CHECK 2: RATE LIMITING (Max 1 call per phone number per hour)
        // ---------------------------------------------------------------------
        const bypassRateLimit = process.env.BYPASS_RATE_LIMIT === 'true';
        const lastCall = lastCallByPhone[destinationPhone];
        const nowMs = Date.now();
        const oneHourMs = 60 * 60 * 1000;

        if (!bypassRateLimit && lastCall && (nowMs - lastCall < oneHourMs)) {
            const remainingMins = Math.ceil((oneHourMs - (nowMs - lastCall)) / 60000);
            const rateLimitMsg = `Rate limit exceeded: A call to ${destinationPhone} was placed recently. Please wait ${remainingMins} minute(s) before calling again.`;
            logCall(action, destinationPhone, target.name, agentId, 'rate_limited', null, rateLimitMsg);
            return res.status(429).json({ success: false, error: rateLimitMsg });
        }

        // ---------------------------------------------------------------------
        // BOLNA OUTBOUND CALL API INVOCATION
        // ---------------------------------------------------------------------
        // Official Bolna API: POST https://api.bolna.ai/call
        // Headers: Authorization: Bearer <BOLNA_API_KEY>, Content-Type: application/json
        const bolnaPayload = {
            agent_id: agentId,
            recipient_phone_number: destinationPhone,
            user_data: {
                recipient_name: target.name,
                contact_person: target.contactPerson || '',
                amount_pending: target.amountPending || '',
                invoice_id: target.invoiceId || '',
                action: action,
                called_via: 'voice_command_homepage'
            }
        };

        let executionId = `exec_${Date.now()}`;
        let bolnaStatus = 'queued';

        if (!bolnaKey || bolnaKey.startsWith('your_') || bolnaKey === 'mock') {
            // Simulated call mode
            executionId = `sim_bolna_${Date.now()}`;
            logCall(action, destinationPhone, target.name, agentId, 'simulated', executionId, 'Mock API key');
            lastCallByPhone[destinationPhone] = nowMs;

            return res.json({
                success: true,
                status: 'queued',
                simulated: true,
                execution_id: executionId,
                callee_name: target.name,
                phone_number: destinationPhone,
                amount_pending: target.amountPending || null,
                action: action,
                agent_id: agentId,
                message: `[Simulated] Call initiated for ${target.name} (${destinationPhone}) via Bolna agent.`
            });
        }

        try {
            const bolnaResp = await axios.post('https://api.bolna.ai/call', bolnaPayload, {
                headers: {
                    'Authorization': `Bearer ${bolnaKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 25000
            });

            const data = bolnaResp.data || {};
            executionId = data.execution_id || data.id || executionId;
            bolnaStatus = data.status || 'queued';

            // Record rate limit timestamp
            lastCallByPhone[destinationPhone] = nowMs;

            // Log successful outbound call
            logCall(action, destinationPhone, target.name, agentId, bolnaStatus, executionId, 'Dispatched to Bolna API');

            return res.json({
                success: true,
                status: bolnaStatus,
                execution_id: executionId,
                callee_name: target.name,
                phone_number: destinationPhone,
                amount_pending: target.amountPending || null,
                action: action,
                agent_id: agentId,
                message: `Outbound call to ${target.name} (${destinationPhone}) placed successfully.`
            });

        } catch (apiErr) {
            const upstreamError = apiErr.response ? JSON.stringify(apiErr.response.data) : apiErr.message;
            console.error('[Bolna Upstream Error]', upstreamError);
            logCall(action, destinationPhone, target.name, agentId, 'failed', null, upstreamError);

            return res.status(apiErr.response ? apiErr.response.status : 502).json({
                success: false,
                status: 'failed',
                error: `Bolna API call failed: ${apiErr.response?.data?.message || apiErr.message}`,
                upstream: apiErr.response?.data
            });
        }

    } catch (err) {
        console.error('[Voice Command Server Error]', err);
        return res.status(500).json({ success: false, error: 'Internal server error: ' + err.message });
    }
});

// =============================================================================
// API 2B: BOLNA OUTBOUND CALL TRIGGER (POST /api/call/bolna)
// Matches endpoint called from dashboard-tft.html supplier and collections lists
// =============================================================================
app.post('/api/call/bolna', async (req, res) => {
    try {
        const { agentId, agentType, phoneNumber, recipientName, contextData } = req.body || {};
        const type = (agentType || 'supplier').toLowerCase();

        // 1. Resolve agent ID
        let resolvedAgentId = (agentId || '').trim();
        if (!resolvedAgentId || resolvedAgentId.length < 8) {
            if (type.includes('suppl')) {
                resolvedAgentId = process.env.BOLNA_SUPPLIER_AGENT_ID || process.env.BOLNA_AGENT_ID_SUPPLIER || '4ee43af0-7773-487b-9262-2710f68311f8';
            } else {
                resolvedAgentId = process.env.BOLNA_COLLECTIONS_AGENT_ID || process.env.BOLNA_AGENT_ID_PAYMENT || '28712767-d9a9-4c6a-b7ed-6481d0357c16';
            }
        }

        // 2. Resolve destination phone number
        const isTestMode = process.env.TEST_MODE === 'true';
        const testPhone = process.env.TEST_PHONE_NUMBER || '+916363077110';
        const rawPhone = isTestMode ? testPhone : (phoneNumber || testPhone);
        const destinationPhone = formatE164(rawPhone);

        const recName = recipientName || (type.includes('suppl') ? 'Supplier' : 'Customer');

        // 3. Business hours check (if enabled)
        const enforceWindow = process.env.CALL_WINDOW_ENFORCE === 'true';
        const startHour = parseInt(process.env.CALL_WINDOW_START_HOUR || '9', 10);
        const endHour = parseInt(process.env.CALL_WINDOW_END_HOUR || '19', 10);
        const currentHour = new Date().getHours();

        if (enforceWindow && (currentHour < startHour || currentHour >= endHour)) {
            const timeMsg = `Calls are restricted to business hours (${startHour}:00 AM to ${endHour > 12 ? endHour - 12 : endHour}:00 PM).`;
            logCall(`call_${type}`, destinationPhone, recName, resolvedAgentId, 'blocked_outside_hours', null, timeMsg);
            return res.status(403).json({ success: false, error: timeMsg, message: timeMsg });
        }

        // 4. Rate limit check (unless BYPASS_RATE_LIMIT is true)
        const bypassRateLimit = process.env.BYPASS_RATE_LIMIT === 'true';
        const lastCall = lastCallByPhone[destinationPhone];
        const nowMs = Date.now();
        const oneHourMs = 60 * 60 * 1000;

        if (!bypassRateLimit && lastCall && (nowMs - lastCall < oneHourMs)) {
            const remainingMins = Math.ceil((oneHourMs - (nowMs - lastCall)) / 60000);
            const rateLimitMsg = `Rate limit: Call placed recently. Please wait ${remainingMins} min(s).`;
            logCall(`call_${type}`, destinationPhone, recName, resolvedAgentId, 'rate_limited', null, rateLimitMsg);
            return res.status(429).json({ success: false, error: rateLimitMsg, message: rateLimitMsg });
        }

        // 5. Check Bolna API Key
        const bolnaKey = (process.env.BOLNA_API_KEY || '').trim();

        if (!bolnaKey || bolnaKey.startsWith('your_') || bolnaKey === 'mock') {
            const simId = `sim_bolna_${nowMs}`;
            logCall(`call_${type}`, destinationPhone, recName, resolvedAgentId, 'simulated', simId, 'Simulated mode');
            lastCallByPhone[destinationPhone] = nowMs;
            return res.json({
                success: true,
                status: 'queued',
                simulated: true,
                execution_id: simId,
                recipient_name: recName,
                phone_number: destinationPhone,
                agent_id: resolvedAgentId,
                message: `[Simulated] Call dispatched to ${recName} (${destinationPhone})`
            });
        }

        // 6. Invoke official Bolna API
        const bolnaPayload = {
            agent_id: resolvedAgentId,
            recipient_phone_number: destinationPhone,
            user_data: {
                business_name: 'SME Growth Advisor',
                recipient_name: recName,
                agent_type: type,
                context: contextData || {},
                timestamp: new Date().toISOString()
            }
        };

        const bolnaResp = await axios.post('https://api.bolna.ai/call', bolnaPayload, {
            headers: {
                'Authorization': `Bearer ${bolnaKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });

        const data = bolnaResp.data || {};
        const executionId = data.execution_id || data.id || `exec_${nowMs}`;
        const bolnaStatus = data.status || 'queued';

        lastCallByPhone[destinationPhone] = nowMs;
        logCall(`call_${type}`, destinationPhone, recName, resolvedAgentId, bolnaStatus, executionId, 'Dispatched to Bolna API');

        return res.json({
            success: true,
            status: bolnaStatus,
            execution_id: executionId,
            recipient_name: recName,
            phone_number: destinationPhone,
            agent_id: resolvedAgentId,
            message: `Call dispatched successfully to ${recName} (${destinationPhone})`
        });

    } catch (apiErr) {
        const upstreamError = apiErr.response ? JSON.stringify(apiErr.response.data) : apiErr.message;
        console.error('[Bolna Call Error]', upstreamError);
        const errMsg = apiErr.response?.data?.message || apiErr.response?.data?.error || apiErr.message;
        return res.status(apiErr.response ? apiErr.response.status : 502).json({
            success: false,
            error: `Bolna call failed: ${errMsg}`,
            message: `Bolna call failed: ${errMsg}`
        });
    }
});

// =============================================================================
// API 2C: ELEVENLABS CALL TRIGGER (POST /api/call/elevenlabs)
// =============================================================================
app.post('/api/call/elevenlabs', async (req, res) => {
    try {
        const xiKey = (process.env.ELEVENLABS_API_KEY || '').trim();
        const agentId = req.body?.agentId || (process.env.ELEVENLABS_AGENT_ID || '').trim() || 'agent_1901m4kqdmycfkn9pra87mp8jmtd';
        const phoneNumberId = (process.env.ELEVENLABS_PHONE_NUMBER_ID || '').trim();

        const isTestMode = process.env.TEST_MODE === 'true';
        const testPhone = process.env.TEST_PHONE_NUMBER || '+916363077110';
        const rawPhone = isTestMode ? testPhone : (req.body?.phoneNumber || testPhone);
        const destinationPhone = formatE164(rawPhone);

        if (!xiKey || xiKey.startsWith('your_') || !phoneNumberId) {
            return res.json({
                success: true,
                status: 'queued',
                simulated: true,
                provider: 'elevenlabs',
                agent_id: agentId,
                conversation_id: `conv_sim_${Date.now()}`,
                to_number: destinationPhone,
                message: `[Simulated] ElevenLabs voice agent call simulated for ${destinationPhone}`
            });
        }

        const payload = {
            agent_id: agentId,
            phone_number_id: phoneNumberId,
            to_number: destinationPhone,
            conversation_initiation_client_data: {
                conversation_config_override: {
                    agent: {
                        first_message: "Hello! I am your SME AI Advisor powered by ElevenLabs. How can I help you today?"
                    }
                }
            }
        };

        const resp = await axios.post('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', payload, {
            headers: {
                'xi-api-key': xiKey,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });

        return res.json({
            success: true,
            provider: 'elevenlabs',
            data: resp.data,
            message: `ElevenLabs outbound voice call queued for ${destinationPhone}`
        });
    } catch (err) {
        console.error('[ElevenLabs Call Error]', err.response?.data || err.message);
        return res.status(502).json({
            success: false,
            error: err.response?.data?.detail || err.message,
            message: err.message
        });
    }
});

// =============================================================================
// API 3: GET CALL STATUS (GET /api/call-status/:id)
// =============================================================================
app.get('/api/call-status/:id', async (req, res) => {
    const { id } = req.params;
    const bolnaKey = (process.env.BOLNA_API_KEY || '').trim();

    if (!id) {
        return res.status(400).json({ error: 'Execution ID is required.' });
    }

    // Handle simulated call IDs
    if (id.startsWith('sim_') || !bolnaKey || bolnaKey.startsWith('your_')) {
        return res.json({
            execution_id: id,
            status: 'in-progress',
            conversation_duration: 12,
            simulated: true
        });
    }

    try {
        const resp = await axios.get(`https://api.bolna.ai/executions/${id}`, {
            headers: {
                'Authorization': `Bearer ${bolnaKey}`
            },
            timeout: 10000
        });

        const data = resp.data || {};
        return res.json({
            execution_id: id,
            status: data.status || 'in-progress',
            conversation_duration: data.conversation_duration || 0,
            summary: data.summary || '',
            transcript: data.transcript || ''
        });
    } catch (err) {
        // Fallback gracefully if execution ID is newly queued
        return res.json({
            execution_id: id,
            status: 'queued',
            message: 'Waiting for call progress update from carrier.'
        });
    }
});

// =============================================================================
// DATA DIRECTORY ENDPOINTS (Suppliers & Customers)
// =============================================================================
app.get('/api/suppliers', (req, res) => {
    const suppliers = loadJsonData(SUPPLIERS_PATH, []);
    res.json(suppliers);
});

app.get('/api/customers', (req, res) => {
    const customers = loadJsonData(CUSTOMERS_PATH, []);
    res.json(customers);
});

app.get('/api/pending-payments', (req, res) => {
    const customers = loadJsonData(CUSTOMERS_PATH, []);
    res.json(customers);
});

app.get('/api/logs', (req, res) => {
    try {
        const logs = fs.readFileSync(CALLS_LOG_PATH, 'utf8');
        res.type('text/plain').send(logs);
    } catch (err) {
        res.status(500).send('Error reading logs.');
    }
});

// =============================================================================
// STATIC ASSET SERVING & FALLBACK ROUTES
// =============================================================================
// Explicit root & TFT routes placed BEFORE static to ensure TFT edition is always served
app.get(['/', '/dashboard-tft.html', '/tft', '/index.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'dashboard-tft.html'));
});

app.get('/desktop', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'index.html'))) {
        res.sendFile(path.join(__dirname, 'index.html'));
    } else {
        res.redirect('/dashboard-tft.html');
    }
});

app.use(express.static(path.join(__dirname), {
    index: false,
    etag: false,
    maxAge: 0,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// Start Express Server
app.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(` SME Growth Advisor - Voice Telephony Server Active`);
    console.log(` Running on: http://localhost:${PORT}`);
    console.log(` TFT UI URL: http://localhost:${PORT}/dashboard-tft.html`);
    console.log(` Test Mode : ${process.env.TEST_MODE === 'true' ? 'ENABLED (Calls to ' + process.env.TEST_PHONE_NUMBER + ')' : 'DISABLED'}`);
    console.log(` Business Hours: ${process.env.CALL_WINDOW_START_HOUR || 9}:00 to ${process.env.CALL_WINDOW_END_HOUR || 19}:00`);
    console.log(`========================================================`);
});
