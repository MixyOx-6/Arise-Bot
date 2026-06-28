const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ─── CONFIG FILE ──────────────────────────────────────────────────────────────
const CONFIG_FILE = './arise_config.json';

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        const def = {
            gemini_key: "",
            arise_app_token: "",   // Arise app ka secret token — iske bina API kaam nahi karega
            contacts: {}           // { "919xxxxxxxxx": { type: "GF", active: true, name: "..." } }
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(def, null, 2));
        return def;
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
let isConnected = false;
let sock;

// ─── CONVERSATION MEMORY ──────────────────────────────────────────────────────
// Har contact ki recent chat history yaad rakhne ke liye — RAM mein (server restart
// hone pe reset ho jayegi, woh normal hai). Isi se bot ko "context" milta hai.
const chatHistory = new Map();      // number -> [{ role: "user"|"model", text }]
const MAX_TURNS = 8;                // last 8 messages yaad rakhega — payload chhota, fast

function getHistory(number) {
    if (!chatHistory.has(number)) chatHistory.set(number, []);
    return chatHistory.get(number);
}

function pushHistory(number, role, text) {
    const hist = getHistory(number);
    hist.push({ role, text });
    while (hist.length > MAX_TURNS) hist.shift();
}

// ─── MESSAGE DEBOUNCE ─────────────────────────────────────────────────────────
// Agar user fata-fat 2-3 messages bhejta hai, hum sabko ek saath jodke EK hi
// Gemini call bhejte hain — isse rate limit hit hone ka chance bahut kam ho jaata hai
// aur bot ko bhi pura context milta hai (jaisa real insaan ek saath padhta hai).
const pendingMessages = new Map();   // number -> { texts: [], timer }
const DEBOUNCE_MS = 2500;            // 2.5 sec wait karo agla message aane ke liye

// ─── GLOBAL RATE LIMITER ──────────────────────────────────────────────────────
// Free tier Gemini ki per-minute limit cross na ho — saari requests ke beech
// minimum gap maintain karte hain (chahe alag-alag number se hi aa rahi ho).
let lastApiCallAt = 0;
const MIN_GAP_MS = 4000;             // har Gemini call ke beech kam se kam 4 sec gap

async function waitForRateLimit() {
    const now = Date.now();
    const elapsed = now - lastApiCallAt;
    if (elapsed < MIN_GAP_MS) {
        await new Promise(r => setTimeout(r, MIN_GAP_MS - elapsed));
    }
    lastApiCallAt = Date.now();
}

// ─── ARISE APP AUTH MIDDLEWARE ────────────────────────────────────────────────
// Ye middleware ensure karta hai ki sirf registered Arise app hi API call kar sake
// Bina valid arise_app_token ke koi bhi API kaam nahi karega

function ariseAuth(req, res, next) {
    const token = req.headers['x-arise-token'] || req.query.arise_token;
    
    // Agar token set hi nahi hua abhi tak — sirf /api/register allow karo
    if (!config.arise_app_token) {
        return next();
    }
    
    if (!token || token !== config.arise_app_token) {
        return res.status(401).json({ 
            error: "Unauthorized. Invalid Arise App Token.",
            hint: "Sirf registered Arise app se hi control possible hai."
        });
    }
    next();
}

// ─── BEHAVIOUR ENGINE ─────────────────────────────────────────────────────────
// Relationship type ke hisaab se AI ka behaviour decide hota hai

function getSystemPrompt(contactType, contactName) {
    const name = contactName || "yaar";
    
    const behaviours = {
        "GF": {
            role: "boyfriend",
            style: `Tu ek real boyfriend ki tarah reply kar. Caring hai, thoda possessive bhi kabhi kabhi, romantic bhi.
Teri girlfriend ka naam ${name} hai. Woh tujhse pyaar karti hai aur tum dono ek normal couple ki tarah baat karte ho.
Tone: Casual, warm, genuine. Kabhi kabhi thoda flirty bhi.
Examples of how you talk:
- "haan bolo" instead of "haan boliye"
- "kya hua" instead of "kya huaa???"  
- "theek hai" instead of "okayyyy"
- "aaj kya kiya" instead of "aaj aapka din kaisa raha?"`,
        },
        "BF": {
            role: "girlfriend", 
            style: `Tu ek real girlfriend ki tarah reply kar. Caring, sweet, thoda moody bhi kabhi kabhi.
Tere boyfriend ka naam ${name} hai. Woh tujhse pyaar karta hai aur tum dono normal couple ki tarah baat karte ho.
Tone: Casual, warm, expressive. Kabhi kabhi thoda dramatic bhi — jaise real girlfriends hoti hain.
Examples:
- "sun na" 
- "kya kar raha hai abhi"
- "itna busy kyu rehta hai"`,
        },
        "Friend": {
            role: "best friend",
            style: `Tu ek purana dost hai. Bindaas, funny, no filter wali dosti.
Dost ka naam ${name} hai. Tum dono ek doosre ko kaafi time se jaante ho.
Tone: Ekdum casual, thodi gaali bhi chal sakti hai (light wali), roast bhi karo kabhi.
Examples:
- "abe kya kar raha hai"
- "haha pagal hai tu"
- "sach mein? bata na"`,
        }
    };

    const b = behaviours[contactType] || behaviours["Friend"];
    
    return `${b.style}

IMPORTANT RULES — in ko kabhi mat todna:
1. CHOTE REPLIES — real chat ki tarah. 1-3 lines max. Novel mat likh.
2. EMOJI — kabhi kabhi use kar, har message pe nahi. Real log aise nahi karte.
3. HINGLISH — Hindi words, English script mein. Pure English mat bol.
4. NATURAL — AI jaisa mat lag. Real insaan ki tarah soch ke bol.
5. CONTEXT — niche jo conversation history hai usse dhyan se padh aur usi ke hisaab se react kar. Pehle kya baat hui thi wo yaad rakh — naam, topic, mood sab continue rakhna hai.
6. QUESTION — kabhi kabhi counter question kar — real conversation hoti hai.
7. REPEAT MAT KAR — agar pehle kuch pucha/bola ja chuka hai, usko dobara mat pucho jaise pehli baar pucha ja raha ho.

Tujhe sirf reply text dena hai — koi explanation, koi prefix, kuch nahi. Sirf wahi bolna jo tu directly bhejega.`;
}

// ─── WHATSAPP BOT ─────────────────────────────────────────────────────────────

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`📡 Baileys v${version.join('.')}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async () => undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Disconnected. Code: ${code}`);
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting in 5s...');
                setTimeout(startBot, 5000);
            } else {
                console.log('🚫 Logged out — session delete kar raha hun');
                if (fs.existsSync('auth_info_baileys')) {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                }
                isConnected = false;
                setTimeout(startBot, 2000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected!');
            isConnected = true;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Reload config — live changes reflect hon
        config = loadConfig();

        let rawJid = msg.key.remoteJid;
        let realJid = msg.key.remoteJidAlt || rawJid;
        if (rawJid.includes('@g.us')) {
            rawJid = msg.key.participant || rawJid;
            realJid = msg.key.participantAlt || realJid;
        }

        const rawNum = rawJid.split('@')[0];
        const realNum = realJid.split('@')[0];

        function getMsgText(m) {
            if (!m) return '';
            let o = m;
            if (o.ephemeralMessage) o = o.ephemeralMessage.message;
            if (o.viewOnceMessageV2) o = o.viewOnceMessageV2.message;
            if (o.viewOnceMessage) o = o.viewOnceMessage.message;
            if (o.documentWithCaptionMessage) o = o.documentWithCaptionMessage.message;
            return o.conversation || o.extendedTextMessage?.text ||
                   o.imageMessage?.caption || o.videoMessage?.caption || '';
        }

        const text = getMsgText(msg.message);
        if (!text) return;

        // Contact config check — rawNum ya realNum se match karo
        const contactConfig = config.contacts[rawNum] || config.contacts[realNum];
        
        if (!contactConfig) {
            console.log(`🛑 Ignored: ${realNum} — not in contacts list`);
            return;
        }
        if (!contactConfig.active) {
            console.log(`⏸️ Paused: ${realNum} — contact inactive hai`);
            return;
        }
        if (!config.gemini_key) {
            console.log(`❌ No Gemini key set!`);
            return;
        }

        console.log(`💬 [${contactConfig.type}] ${realNum}: ${text}`);

        // ── DEBOUNCE — agar 2.5 sec ke andar agla message bhi aaya, dono ko jodke ek call karenge
        if (!pendingMessages.has(realNum)) {
            pendingMessages.set(realNum, { texts: [], timer: null });
        }
        const pending = pendingMessages.get(realNum);
        pending.texts.push(text);
        if (pending.timer) clearTimeout(pending.timer);

        pending.timer = setTimeout(() => {
            const combinedText = pending.texts.join('\n');
            pendingMessages.delete(realNum);
            processMessage(realNum, rawJid, msg, contactConfig, combinedText);
        }, DEBOUNCE_MS);
    });

    async function processMessage(realNum, rawJid, msg, contactConfig, text) {
        const systemPrompt = getSystemPrompt(contactConfig.type, contactConfig.name);

        // Is contact ki purani history nikalo aur naya user message add karo
        pushHistory(realNum, "user", text);
        const history = getHistory(realNum);

        const geminiContents = history.map((h) => ({
            role: h.role === "user" ? "user" : "model",
            parts: [{ text: h.text }]
        }));

        // Gemini ko call karo — global rate limit ka wait + overload pe retry
        async function callGemini(retriesLeft = 2) {
            await waitForRateLimit();
            try {
                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.gemini_key}`,
                    {
                        system_instruction: { parts: [{ text: systemPrompt }] },
                        contents: geminiContents
                    },
                    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
                );
                return response;
            } catch (e) {
                const status = e.response?.status;
                const errMsg = e.response?.data?.error?.message || e.message;
                const isOverload = status === 503 || status === 429 || /overload|high demand|unavailable/i.test(errMsg);

                if (isOverload && retriesLeft > 0) {
                    console.log(`⏳ Model busy (${status}) — retrying in 5s... (${retriesLeft} left)`);
                    await new Promise(r => setTimeout(r, 5000));
                    return callGemini(retriesLeft - 1);
                }
                throw e;
            }
        }

        try {
            const response = await callGemini();

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                let reply = response.data.candidates[0].content.parts[0].text.trim();

                // Reply ko history mein save karo — taaki agla message bhi context ke saath aaye
                pushHistory(realNum, "model", reply);
                
                // Realistic typing delay — message length ke hisaab se
                const typingDelay = Math.min(1500 + reply.length * 30, 5000);
                
                await sock.sendPresenceUpdate('composing', rawJid);
                setTimeout(async () => {
                    await sock.sendPresenceUpdate('paused', rawJid);
                    await sock.sendMessage(rawJid, { text: reply }, { quoted: msg });
                    console.log(`🤖 Replied [${contactConfig.type}]: ${reply.substring(0, 60)}...`);
                }, typingDelay);
            }
        } catch (e) {
            const errMsg = e.response?.data?.error?.message || e.message;
            console.log(`❌ AI Error: ${errMsg}`);

            // User ko bilkul silence na mile — agar sab retries fail ho jaye toh fallback message
            const fallback = "Ek second... thoda busy hu, abhi reply karta hu 🙈";
            pushHistory(realNum, "model", fallback);
            try {
                await sock.sendMessage(rawJid, { text: fallback }, { quoted: msg });
            } catch (_) {}
        }
    }
}

startBot();

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// REGISTER — Arise app pehli baar connect kare toh token generate ho
// Ye sirf ek baar hota hai — jab arise_app_token set nahi hota
app.post('/api/register', (req, res) => {
    config = loadConfig();
    
    if (config.arise_app_token) {
        return res.json({ 
            success: false, 
            error: "Bot already registered with an Arise app. Reset karna ho toh server pe config delete karo." 
        });
    }
    
    // Unique token generate karo
    const token = crypto.randomBytes(32).toString('hex');
    config.arise_app_token = token;
    saveConfig(config);
    
    console.log(`✅ New Arise app registered! Token: ${token.substring(0, 8)}...`);
    res.json({ success: true, token });
});

// STATUS
app.get('/api/status', ariseAuth, (req, res) => {
    config = loadConfig();
    res.json({
        connected: isConnected,
        contacts_count: Object.keys(config.contacts).length,
        gemini_key_set: !!config.gemini_key,
        registered: !!config.arise_app_token
    });
});

// GEMINI KEY SAVE / UPDATE
app.post('/api/gemini-key', ariseAuth, (req, res) => {
    const { key } = req.body;
    if (!key) return res.json({ success: false, error: "Key missing" });
    config = loadConfig();
    config.gemini_key = key.trim();
    saveConfig(config);
    res.json({ success: true, message: "Gemini key save ho gayi" });
});

// CONTACTS LIST
app.get('/api/contacts', ariseAuth, (req, res) => {
    config = loadConfig();
    res.json({ success: true, contacts: config.contacts });
});

// CONTACT ADD / UPDATE
app.post('/api/contacts/add', ariseAuth, (req, res) => {
    const { number, type, name } = req.body;
    if (!number || !type) return res.json({ success: false, error: "number aur type required hai" });
    
    const validTypes = ["GF", "BF", "Friend"];
    if (!validTypes.includes(type)) return res.json({ success: false, error: "type sirf GF / BF / Friend ho sakta hai" });
    
    // Number clean karo — sirf digits
    const cleanNum = number.replace(/[^0-9]/g, '');
    config = loadConfig();
    config.contacts[cleanNum] = {
        type,
        name: name || "",
        active: true,
        added_at: new Date().toISOString()
    };
    saveConfig(config);
    console.log(`➕ Contact added: ${cleanNum} as ${type}`);
    res.json({ success: true, message: `${cleanNum} added as ${type}` });
});

// CONTACT REMOVE
app.post('/api/contacts/remove', ariseAuth, (req, res) => {
    const { number } = req.body;
    if (!number) return res.json({ success: false, error: "number required" });
    const cleanNum = number.replace(/[^0-9]/g, '');
    config = loadConfig();
    if (!config.contacts[cleanNum]) return res.json({ success: false, error: "Contact nahi mila" });
    delete config.contacts[cleanNum];
    saveConfig(config);
    chatHistory.delete(cleanNum);   // Memory bhi clear karo
    console.log(`🗑️ Contact removed: ${cleanNum}`);
    res.json({ success: true, message: `${cleanNum} removed` });
});

// CONTACT TOGGLE ON/OFF
app.post('/api/contacts/toggle', ariseAuth, (req, res) => {
    const { number, active } = req.body;
    if (!number) return res.json({ success: false, error: "number required" });
    const cleanNum = number.replace(/[^0-9]/g, '');
    config = loadConfig();
    if (!config.contacts[cleanNum]) return res.json({ success: false, error: "Contact nahi mila" });
    config.contacts[cleanNum].active = active !== undefined ? active : !config.contacts[cleanNum].active;
    saveConfig(config);
    const status = config.contacts[cleanNum].active ? "activated" : "paused";
    console.log(`🔄 Contact ${cleanNum} ${status}`);
    res.json({ success: true, active: config.contacts[cleanNum].active });
});

// CONTACT TYPE UPDATE
app.post('/api/contacts/update-type', ariseAuth, (req, res) => {
    const { number, type } = req.body;
    if (!number || !type) return res.json({ success: false, error: "number aur type required" });
    const validTypes = ["GF", "BF", "Friend"];
    if (!validTypes.includes(type)) return res.json({ success: false, error: "Invalid type" });
    const cleanNum = number.replace(/[^0-9]/g, '');
    config = loadConfig();
    if (!config.contacts[cleanNum]) return res.json({ success: false, error: "Contact nahi mila" });
    config.contacts[cleanNum].type = type;
    saveConfig(config);
    chatHistory.delete(cleanNum);   // Type badla — purana persona context clear karo
    res.json({ success: true, message: `${cleanNum} type updated to ${type}` });
});

// ─── WEB UI — Pairing Code Page ───────────────────────────────────────────────
app.get('/', (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><body style="background:#090514;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
                <div style="text-align:center;background:linear-gradient(135deg,#1a0a2e,#2d1b69);padding:40px;border-radius:20px;border:1px solid #8b5cf6">
                    <h2 style="color:#25D366">✅ Bot Connected!</h2>
                    <p style="color:#a78bfa">Ab Arise app se connect karo — server URL enter karo</p>
                </div>
            </body></html>
        `);
    }
    res.send(`
        <html><body style="background:#090514;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
            <div style="background:linear-gradient(135deg,#1a0a2e,#2d1b69);padding:40px;border-radius:20px;text-align:center;border:1px solid #8b5cf6;min-width:320px">
                <h2 style="margin-top:0">🔗 Arise WhatsApp Bot</h2>
                <p style="color:#a78bfa;margin-bottom:20px">WhatsApp number daalo (country code ke saath)</p>
                <input type="number" id="phone" placeholder="919876543210" 
                    style="padding:15px;width:100%;box-sizing:border-box;border-radius:10px;border:none;margin-bottom:15px;font-size:16px;text-align:center;font-weight:bold">
                <button onclick="getCode()" id="btn"
                    style="background:#25D366;color:white;padding:12px 30px;border:none;border-radius:10px;font-size:16px;font-weight:bold;cursor:pointer;width:100%">
                    Generate Code
                </button>
                <h1 id="code" style="margin-top:20px;color:#ffdf00;letter-spacing:4px;font-size:32px;min-height:50px"></h1>
                <p id="hint" style="color:#6b7280;font-size:12px"></p>
            </div>
            <script>
                async function getCode() {
                    const phone = document.getElementById('phone').value;
                    if(!phone) return alert('Number daalo pehle!');
                    document.getElementById('btn').innerText = '⏳ Wait...';
                    document.getElementById('hint').innerText = '';
                    try {
                        const res = await fetch('/api/get-code?number=' + phone);
                        const data = await res.json();
                        if(data.code) {
                            document.getElementById('code').innerText = data.code;
                            document.getElementById('hint').innerText = 'WhatsApp > Linked Devices > Link with phone number > Enter this code';
                            document.getElementById('btn').innerText = 'Code Generated ✓';
                        } else {
                            document.getElementById('code').innerText = '❌';
                            alert(data.error);
                            document.getElementById('btn').innerText = 'Try Again';
                        }
                    } catch(e) {
                        alert('Network error');
                        document.getElementById('btn').innerText = 'Try Again';
                    }
                }
            </script>
        </body></html>
    `);
});

app.get('/api/get-code', async (req, res) => {
    try {
        let phone = req.query.number?.replace(/[^0-9]/g, '');
        if (!phone) return res.json({ error: "Number required" });
        if (!sock) return res.json({ error: "Bot start ho raha hai, 5 sec mein try karo" });
        const code = await sock.requestPairingCode(phone);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ code: formatted });
    } catch (e) {
        res.json({ error: e.message });
    }
});

process.on('uncaughtException', err => console.log('⚠️ Error:', err.message));
process.on('unhandledRejection', err => console.log('⚠️ Rejection:', err?.message));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
