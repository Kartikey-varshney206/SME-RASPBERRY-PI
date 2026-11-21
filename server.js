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
const ExcelJS = require('exceljs');

// Load environment configuration
dotenv.config();

// Global crash protection
process.on('uncaughtException', (err) => {
    console.error('[Server Uncaught Exception]', err.message, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server Unhandled Rejection]', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Safe handling of malformed JSON from web clients/tunnels
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
    }
    next(err);
});
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
        const agentId = req.body?.agentId || (process.env.ELEVENLABS_AGENT_ID || '').trim() || 'agent_7301m7yskfjberetytdk0ds7gdag';
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
// BOOKKEEPING & LEDGER EXCEL API (data/ledger.xlsx)
// =============================================================================
const DATA_DIR = path.join(__dirname, 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const LEDGER_PATH = path.join(DATA_DIR, 'ledger.xlsx');
const LEDGER_LOG_PATH = path.join(__dirname, 'ledger.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

function logLedger(entry) {
    const timestamp = new Date().toISOString();
    try {
        fs.appendFileSync(LEDGER_LOG_PATH, `[${timestamp}] ${entry}\n`, 'utf8');
    } catch (err) {
        console.error('Error writing to ledger.log:', err.message);
    }
}

function makeLedgerBackup() {
    try {
        if (fs.existsSync(LEDGER_PATH)) {
            const backupFile = path.join(BACKUPS_DIR, `ledger_backup_${Date.now()}.xlsx`);
            fs.copyFileSync(LEDGER_PATH, backupFile);
        }
    } catch (err) {
        console.error('Failed to create ledger backup:', err.message);
    }
}

async function ensureLedgerWorkbook() {
    if (fs.existsSync(LEDGER_PATH)) return;
    const wb = new ExcelJS.Workbook();
    const custSheet = wb.addWorksheet('Customers');
    custSheet.columns = [
        { header: 'Name', key: 'name', width: 25 },
        { header: 'Phone', key: 'phone', width: 20 },
        { header: 'Balance', key: 'balance', width: 15 }
    ];
    custSheet.addRow({ name: 'Sharma', phone: '+919876543210', balance: 15000 });
    custSheet.addRow({ name: 'Anuj', phone: '+919876543211', balance: 8000 });
    custSheet.addRow({ name: 'Aman', phone: '+919876543212', balance: 22000 });

    const ledgerSheet = wb.addWorksheet('Ledger');
    ledgerSheet.columns = [
        { header: 'Date', key: 'date', width: 22 },
        { header: 'Customer', key: 'customer', width: 25 },
        { header: 'Type', key: 'type', width: 20 },
        { header: 'Amount', key: 'amount', width: 15 },
        { header: 'Note', key: 'note', width: 30 },
        { header: 'Source', key: 'source', width: 15 }
    ];
    ledgerSheet.addRow({ date: '2026-11-20 10:00:00', customer: 'Sharma', type: 'credit_given', amount: 15000, note: 'Opening balance', source: 'system' });
    ledgerSheet.addRow({ date: '2026-11-20 10:30:00', customer: 'Anuj', type: 'credit_given', amount: 8000, note: 'Opening balance', source: 'system' });
    ledgerSheet.addRow({ date: '2026-11-20 11:00:00', customer: 'Aman', type: 'credit_given', amount: 22000, note: 'Opening balance', source: 'system' });

    await wb.xlsx.writeFile(LEDGER_PATH);
    logLedger('INITIALIZE: Created data/ledger.xlsx with sample customers.');
}
ensureLedgerWorkbook().catch(err => console.error('Error ensuring ledger workbook:', err));

// Promise queue ensuring sequential non-conflicting saves
let ledgerQueue = Promise.resolve();
function runInLedgerQueue(task) {
    return new Promise((resolve, reject) => {
        ledgerQueue = ledgerQueue.then(async () => {
            try {
                const res = await task();
                resolve(res);
            } catch (err) {
                reject(err);
            }
        }).catch(err => {
            console.error('[Ledger Queue Exception]', err);
            reject(err);
        });
    });
}

const PAYMENTS_CSV_PATH = path.join(__dirname, 'payments.csv');
const PAYMENTS_XLSX_PATH = path.join(__dirname, 'payments.xlsx');

function parseAmount(val) {
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    if (!val) return 0;
    let s = String(val).toLowerCase().replace(/[,₹$]/g, '').trim();
    if (s.endsWith('k')) {
        return (parseFloat(s.slice(0, -1)) || 0) * 1000;
    }
    if (s.endsWith('lakh') || s.endsWith('lac') || s.endsWith('l')) {
        return (parseFloat(s.replace(/(lakh|lac|l)/, '')) || 0) * 100000;
    }
    if (s.endsWith('cr') || s.endsWith('crore')) {
        return (parseFloat(s.replace(/(cr|crore)/, '')) || 0) * 10000000;
    }
    return parseFloat(s) || 0;
}

function normalizeTransactionType(type) {
    if (!type) return 'payment_received';
    const t = String(type).toLowerCase().trim();
    if (t.includes('paid') || t.includes('payment') || t.includes('received') || t.includes('jama') || t.includes('collect')) {
        return 'payment_received';
    }
    if (t.includes('borrow') || t.includes('credit') || t.includes('udhaar') || t.includes('given')) {
        return 'credit_given';
    }
    if (t.includes('miss') || t.includes('not paid') || t.includes('pending') || t.includes('due')) {
        return 'payment_missed';
    }
    return 'payment_received';
}

function appendToPaymentsCsv({ customer, type, amount, date, time, note, source }) {
    try {
        if (!fs.existsSync(PAYMENTS_CSV_PATH)) {
            fs.writeFileSync(PAYMENTS_CSV_PATH, 'Date,Time,Customer,Type,Amount,Note,Source\r\n', 'utf8');
        }
        const cleanCustomer = String(customer || '').replace(/"/g, '""');
        const cleanNote = String(note || '').replace(/"/g, '""');
        const displayType = (type === 'payment_received') ? 'Payment Received' : (type === 'credit_given' ? 'Credit Given' : 'Payment Missed');
        const line = `"${date}","${time}","${cleanCustomer}","${displayType}",${amount},"${cleanNote}","${source || 'voice'}"\r\n`;
        fs.appendFileSync(PAYMENTS_CSV_PATH, line, 'utf8');
        logLedger(`payments.csv: Appended on the spot -> ${cleanCustomer} ₹${amount} (${displayType})`);
    } catch (err) {
        console.error('Error writing to payments.csv:', err.message);
    }
}

async function updatePaymentsXlsx({ customer, type, amount, date, time, note, source }) {
    try {
        const wb = new ExcelJS.Workbook();
        if (fs.existsSync(PAYMENTS_XLSX_PATH)) {
            try {
                const buf = fs.readFileSync(PAYMENTS_XLSX_PATH);
                if (buf && buf.length > 0) {
                    await wb.xlsx.load(buf);
                }
            } catch (readErr) {
                // If unreadable or empty, fresh workbook
            }
        }
        let sheet = wb.getWorksheet('Payments') || wb.getWorksheet('Sheet1') || wb.worksheets[0];
        if (!sheet) {
            sheet = wb.addWorksheet('Payments');
        }
        if (sheet.rowCount === 0) {
            sheet.columns = [
                { header: 'Date', key: 'date', width: 14 },
                { header: 'Time', key: 'time', width: 12 },
                { header: 'Customer', key: 'customer', width: 22 },
                { header: 'Type', key: 'type', width: 20 },
                { header: 'Amount', key: 'amount', width: 15 },
                { header: 'Note', key: 'note', width: 30 },
                { header: 'Source', key: 'source', width: 15 }
            ];
            const headerRow = sheet.getRow(1);
            headerRow.font = { bold: true };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFE0E7FF' }
            };
        }
        const displayType = (type === 'payment_received') ? 'Payment Received' : (type === 'credit_given' ? 'Credit Given' : 'Payment Missed');
        sheet.addRow([date, time, customer, displayType, amount, note || '', source || 'voice']);
        await wb.xlsx.writeFile(PAYMENTS_XLSX_PATH);
        logLedger(`payments.xlsx: Saved entry on the spot -> ${customer} ₹${amount}`);
    } catch (err) {
        if (err.code === 'EBUSY') {
            console.warn(`[payments.xlsx] Currently open in Excel (EBUSY). Preserved immediately in payments.csv!`);
            logLedger(`payments.xlsx: Open in Excel (EBUSY). Preserved in payments.csv`);
        } else {
            console.error(`[payments.xlsx] Error:`, err.message);
        }
    }
}

// 1. POST /api/ledger { customer_name, type, amount, date?, note? }
app.post('/api/ledger', async (req, res) => {
    try {
        const rawCustomer = req.body.customer_name || req.body.customer || req.body.name || req.body.party || '';
        const rawType = req.body.type || req.body.transaction_type || req.body.action || 'payment_received';
        const rawAmount = req.body.amount || req.body.amt || req.body.value || req.body.price;
        const date = req.body.date;
        const note = req.body.note;
        const source = req.body.source || 'voice';

        const customer_name = String(rawCustomer || 'Customer').trim();
        const type = normalizeTransactionType(rawType);
        const parsedAmount = parseAmount(rawAmount);

        if (parsedAmount <= 0) {
            logLedger(`POST /api/ledger - REJECTED: Invalid amount "${rawAmount}"`);
            return res.status(400).json({ ok: false, error: 'Amount must be greater than zero.' });
        }

        const now = new Date();
        const dateStr = (date && String(date).split(' ')[0]) || now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().split(' ')[0];

        // 1. Instantly append to payments.csv (never blocked by file locks)
        appendToPaymentsCsv({
            customer: customer_name,
            type,
            amount: parsedAmount,
            date: dateStr,
            time: timeStr,
            note: note || `Spoken entry: ${customer_name} ${type.replace(/_/g, ' ')} ₹${parsedAmount}`,
            source
        });

        // 2. Instantly update payments.xlsx
        await updatePaymentsXlsx({
            customer: customer_name,
            type,
            amount: parsedAmount,
            date: dateStr,
            time: timeStr,
            note: note || `Spoken entry: ${customer_name} ${type.replace(/_/g, ' ')} ₹${parsedAmount}`,
            source
        });

        const cleanSearch = customer_name.toLowerCase();

        const result = await runInLedgerQueue(async () => {
            await ensureLedgerWorkbook();
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(LEDGER_PATH);
            const custSheet = wb.getWorksheet('Customers') || wb.worksheets[0];
            const ledgerSheet = wb.getWorksheet('Ledger') || wb.worksheets[1];

            // Customer Matching in Customers sheet
            let matchedRow = null;
            const matches = [];

            for (let i = 2; i <= custSheet.rowCount; i++) {
                const row = custSheet.getRow(i);
                const name = String(row.getCell(1).value || '').trim();
                if (!name) continue;
                const nameLower = name.toLowerCase();

                if (nameLower === cleanSearch) {
                    matchedRow = row;
                    matches.push({ name, row });
                    break;
                } else if (nameLower.includes(cleanSearch) || cleanSearch.includes(nameLower)) {
                    matches.push({ name, row });
                }
            }

            if (!matchedRow) {
                if (matches.length === 1) {
                    matchedRow = matches[0].row;
                }
            }

            let customerFinalName = customer_name;
            let newBalance = 0;
            let warning = undefined;

            if (!matchedRow) {
                // If customer not found in ledger, auto-create so payment NEVER fails!
                if (type === 'credit_given') {
                    newBalance = parsedAmount;
                } else if (type === 'payment_received') {
                    newBalance = 0;
                }
                custSheet.addRow([customerFinalName, '', newBalance]);
                logLedger(`POST /api/ledger - Auto-created customer "${customerFinalName}" with balance ₹${newBalance}`);
            } else {
                customerFinalName = String(matchedRow.getCell(1).value || '').trim();
                const currentBalance = Number(matchedRow.getCell(3).value) || 0;

                if (type === 'credit_given') {
                    newBalance = currentBalance + parsedAmount;
                } else if (type === 'payment_received') {
                    if (parsedAmount > currentBalance) {
                        warning = `Payment amount (₹${parsedAmount}) exceeds outstanding balance (₹${currentBalance}).`;
                    }
                    newBalance = Math.max(0, currentBalance - parsedAmount);
                } else if (type === 'payment_missed') {
                    newBalance = currentBalance;
                }
                matchedRow.getCell(3).value = newBalance;
            }

            // Append Ledger row (Source = "voice")
            const entryDate = `${dateStr} ${timeStr}`;
            const entryNote = (note && String(note).trim()) || (type === 'payment_missed' ? 'Payment missed' : 'Voice transaction');
            ledgerSheet.addRow([entryDate, customerFinalName, type, parsedAmount, entryNote, source]);

            makeLedgerBackup();
            await wb.xlsx.writeFile(LEDGER_PATH);

            logLedger(`POST /api/ledger - SUCCESS: ${type} of ₹${parsedAmount} for ${customerFinalName}. New Balance: ₹${newBalance}`);

            return {
                ok: true,
                customer: customerFinalName,
                type: type,
                amount: parsedAmount,
                new_balance: newBalance,
                warning: warning,
                file_updated: 'payments.csv & payments.xlsx'
            };
        });

        if (!result.ok) {
            return res.status(400).json(result);
        }

        return res.json(result);
    } catch (err) {
        logLedger(`POST /api/ledger - ERROR: ${err.message}`);
        console.error('[Ledger Route Error]', err);
        return res.status(500).json({ ok: false, error: 'Internal ledger error: ' + err.message });
    }
});

// 2. POST /api/ledger/undo (Reverse last Ledger row and update balance)
app.post('/api/ledger/undo', async (req, res) => {
    try {
        const result = await runInLedgerQueue(async () => {
            await ensureLedgerWorkbook();
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(LEDGER_PATH);
            const custSheet = wb.getWorksheet('Customers') || wb.worksheets[0];
            const ledgerSheet = wb.getWorksheet('Ledger') || wb.worksheets[1];

            let lastRowIdx = ledgerSheet.rowCount;
            while (lastRowIdx > 1) {
                const row = ledgerSheet.getRow(lastRowIdx);
                if (row.getCell(2).value) break;
                lastRowIdx--;
            }

            if (lastRowIdx <= 1) {
                return { ok: false, error: 'No transactions found in ledger to undo.' };
            }

            const lastRow = ledgerSheet.getRow(lastRowIdx);
            const rowDate = String(lastRow.getCell(1).value || '');
            const rowCustomer = String(lastRow.getCell(2).value || '').trim();
            const rowType = String(lastRow.getCell(3).value || '').trim();
            const rowAmount = Number(lastRow.getCell(4).value) || 0;
            const rowNote = String(lastRow.getCell(5).value || '');

            let updatedBalance = null;

            for (let i = 2; i <= custSheet.rowCount; i++) {
                const cRow = custSheet.getRow(i);
                const cName = String(cRow.getCell(1).value || '').trim();
                if (cName.toLowerCase() === rowCustomer.toLowerCase()) {
                    let bal = Number(cRow.getCell(3).value) || 0;
                    if (rowType === 'credit_given') {
                        bal = Math.max(0, bal - rowAmount);
                    } else if (rowType === 'payment_received') {
                        bal = bal + rowAmount;
                    }
                    cRow.getCell(3).value = bal;
                    updatedBalance = bal;
                    break;
                }
            }

            ledgerSheet.spliceRows(lastRowIdx, 1);

            makeLedgerBackup();
            await wb.xlsx.writeFile(LEDGER_PATH);

            // Log reversal to payments.csv and payments.xlsx
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0];
            const timeStr = now.toTimeString().split(' ')[0];
            appendToPaymentsCsv({
                customer: rowCustomer,
                type: 'undo_reversal',
                amount: -rowAmount,
                date: dateStr,
                time: timeStr,
                note: `Reversed ${rowType} of ₹${rowAmount}`,
                source: 'undo'
            });
            await updatePaymentsXlsx({
                customer: rowCustomer,
                type: 'undo_reversal',
                amount: -rowAmount,
                date: dateStr,
                time: timeStr,
                note: `Reversed ${rowType} of ₹${rowAmount}`,
                source: 'undo'
            });
            logLedger(`POST /api/ledger/undo - SUCCESS: Reverted ${rowType} of ₹${rowAmount} for ${rowCustomer}.`);

            return {
                ok: true,
                undone_entry: {
                    date: rowDate,
                    customer: rowCustomer,
                    type: rowType,
                    amount: rowAmount,
                    note: rowNote
                },
                new_balance: updatedBalance
            };
        });

        if (!result.ok) {
            return res.status(400).json(result);
        }
        return res.json(result);
    } catch (err) {
        logLedger(`POST /api/ledger/undo - ERROR: ${err.message}`);
        console.error('[Ledger Undo Error]', err);
        return res.status(500).json({ ok: false, error: 'Undo error: ' + err.message });
    }
});

// 3. GET /api/ledger/recent (Last 5 entries from Ledger sheet)
app.get('/api/ledger/recent', async (req, res) => {
    try {
        const result = await runInLedgerQueue(async () => {
            await ensureLedgerWorkbook();
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(LEDGER_PATH);
            const ledgerSheet = wb.getWorksheet('Ledger') || wb.worksheets[1];

            const entries = [];
            for (let i = ledgerSheet.rowCount; i >= 2 && entries.length < 5; i--) {
                const row = ledgerSheet.getRow(i);
                const cust = row.getCell(2).value;
                if (!cust) continue;
                entries.push({
                    date: String(row.getCell(1).value || ''),
                    customer: String(cust || ''),
                    type: String(row.getCell(3).value || ''),
                    amount: Number(row.getCell(4).value) || 0,
                    note: String(row.getCell(5).value || ''),
                    source: String(row.getCell(6).value || 'voice')
                });
            }
            return { ok: true, entries };
        });
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message, entries: [] });
    }
});

// 4. GET /api/summary (Total pending sum of balances for dashboard cards)
app.get('/api/summary', async (req, res) => {
    try {
        const result = await runInLedgerQueue(async () => {
            await ensureLedgerWorkbook();
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(LEDGER_PATH);
            const custSheet = wb.getWorksheet('Customers') || wb.worksheets[0];

            let totalPending = 0;
            let customerCount = 0;
            for (let i = 2; i <= custSheet.rowCount; i++) {
                const row = custSheet.getRow(i);
                const name = row.getCell(1).value;
                if (!name) continue;
                const bal = Number(row.getCell(3).value) || 0;
                totalPending += bal;
                customerCount++;
            }
            return { ok: true, total_pending: totalPending, customer_count: customerCount };
        });
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
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
    res.setHeader('Permissions-Policy', 'microphone=*');
    res.sendFile(path.join(__dirname, 'dashboard-tft.html'));
});

app.get('/desktop', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'index.html'))) {
        res.setHeader('Permissions-Policy', 'microphone=*');
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
        res.setHeader('Permissions-Policy', 'microphone=*');
    }
}));

// Helper: Get local network IP
function getLanIp() {
    try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
                    return net.address;
                }
            }
        }
    } catch (e) {}
    return 'localhost';
}

// Start Express Server
app.listen(PORT, () => {
    const lanIp = getLanIp();
    console.log(`========================================================`);
    console.log(` SME Growth Advisor - Voice Telephony Server Active`);
    console.log(` Localhost  : http://localhost:${PORT}`);
    console.log(` LAN Network: http://${lanIp}:${PORT}`);
    console.log(` TFT UI URL : http://localhost:${PORT}/dashboard-tft.html`);
    console.log(` WebRTC Note: On Raspberry Pi, microphone requires either`);
    console.log(`              http://localhost:${PORT} or the HTTPS tunnel URL.`);
    console.log(` Test Mode  : ${process.env.TEST_MODE === 'true' ? 'ENABLED (Calls to ' + process.env.TEST_PHONE_NUMBER + ')' : 'DISABLED'}`);
    console.log(` Business Hours: ${process.env.CALL_WINDOW_START_HOUR || 9}:00 to ${process.env.CALL_WINDOW_END_HOUR || 19}:00`);
    console.log(`========================================================`);
});
