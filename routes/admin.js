require('dotenv').config(); 
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const adminApp = express.Router();

// Avoid stale admin HTML/JS behind proxies/CDN caches.
adminApp.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Automatically inject CSRF token into all rendered HTML forms.
adminApp.use((req, res, next) => {
    if (typeof req.csrfToken !== 'function') return next();
    const originalSend = res.send.bind(res);

    res.send = (body) => {
        if (typeof body === 'string') {
            const contentType = String(res.get('Content-Type') || '');
            const looksLikeHtml =
                contentType.includes('text/html') ||
                body.includes('<!DOCTYPE html') ||
                body.includes('<html');

            if (looksLikeHtml) {
                const token = req.csrfToken().replace(/"/g, '&quot;');
                body = body.replace(/<form([^>]*)>/gi, `<form$1><input type="hidden" name="_csrf" value="${token}">`);
            }
        }
        return originalSend(body);
    };
    next();
});

// ==========================================
// 🌟 Database Models
// ==========================================
const Group = require('../models/Group');
const User = require('../models/User');
const Master = require('../models/Master');
const Setting = require('../models/Setting'); 

// ==========================================
// 🌟 Utility Modules
// ==========================================
const { generateFullBackupFile, getMMTString, backupDir } = require('../utils/backup');
const { initTelegramBot, sendAutoBackupDocument, sendBackupDocument } = require('../utils/telegram');
const redisClient = require('../config/redis');
const { requireApiKey } = require('../security/apiKey');

// ==========================================
// 🌟 0. NATIVE PASSWORD HASHING
// ==========================================
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password, hash) {
    return hashPassword(password) === hash;
}

// ==========================================
// 🌟 1. Default Admin Account Initializer
// ==========================================
async function initDefaultAdmin() {
    try {
        let setting = await Setting.findOne({});
        if (!setting) {
            setting = new Setting({});
        }

        // Bootstrap admin credentials only when explicitly provided via environment variables.
        const initialAdminUsername = (process.env.INITIAL_ADMIN_USERNAME || '').trim();
        const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD || '';

        if (!setting.adminPasswordHash || setting.adminPasswordHash.length !== 64) {
            if (initialAdminUsername && initialAdminPassword) {
                setting.adminUsername = initialAdminUsername;
                setting.adminPasswordHash = hashPassword(initialAdminPassword);
                await setting.save();
                console.log("✅ Admin bootstrap credentials configured from environment.");
            } else {
                console.warn("⚠️ Admin credentials are not initialized. Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD, then restart.");
            }
        }
    } catch(e) {
        console.error("Admin Init Error:", e);
    }
}
setTimeout(initDefaultAdmin, 2000);


// ==========================================
// 🌟 2. AUTHENTICATION GATEWAY (LOGIN & OTP)
// ==========================================

// Login Page UI
adminApp.get('/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Login - QITO</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        </head>
        <body class="bg-slate-900 h-screen flex items-center justify-center p-4">
            <div class="bg-slate-800 p-8 rounded-3xl shadow-2xl border border-slate-700 w-full max-w-md">
                <div class="text-center mb-8">
                    <div class="w-16 h-16 bg-indigo-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.3)]">
                        <i class="fas fa-shield-alt text-indigo-400 text-3xl"></i>
                    </div>
                    <h2 class="text-2xl font-black text-white tracking-wide">QITO <span class="text-indigo-400">ADMIN</span></h2>
                    <p class="text-slate-400 text-sm mt-1">Authorized Personnel Only</p>
                </div>
                <form action="/admin/login" method="POST" class="space-y-5">
                    <div>
                        <label class="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-widest">Username</label>
                        <input type="text" name="username" required class="w-full bg-slate-900 border border-slate-700 text-white px-4 py-3 rounded-xl outline-none focus:border-indigo-500 transition">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-widest">Password</label>
                        <input type="password" name="password" required class="w-full bg-slate-900 border border-slate-700 text-white px-4 py-3 rounded-xl outline-none focus:border-indigo-500 transition">
                    </div>
                    <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 rounded-xl transition shadow-[0_4px_15px_rgba(79,70,229,0.3)] mt-4">
                        <i class="fas fa-sign-in-alt mr-2"></i> SECURE LOGIN
                    </button>
                </form>
            </div>
        </body>
        </html>
    `);
});

// Process Login
adminApp.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        let setting = await Setting.findOne({});
        
        if (!setting) {
            setting = new Setting({});
        }

        let isValid = false;

        if (!setting.adminPasswordHash || setting.adminPasswordHash.length !== 64) {
            return res.send(`<script>alert('⚠️ Admin credentials are not initialized. Please set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD in .env and restart the server.'); window.location.href='/admin/login';</script>`);
        }

        // Normal check
        if (setting.adminUsername === username) {
            isValid = verifyPassword(password, setting.adminPasswordHash);
        }

        if (isValid) {
            // 🌟 Check if Telegram Bot is Setup
            if (setting.botToken && setting.adminId) {
                try {
                    const otp = Math.floor(100000 + Math.random() * 900000).toString(); 
                    const challengeId = crypto.randomBytes(16).toString('hex');
                    
                    await redisClient.setEx(`otp:${challengeId}`, 300, otp);
                    
                    await axios.post(`https://api.telegram.org/bot${setting.botToken}/sendMessage`, {
                        chat_id: setting.adminId,
                        text: `🔐 *QITO Admin Login OTP*\n\nYour Verification Code is: \`${otp}\`\n\n_Expires in 5 minutes._`,
                        parse_mode: 'Markdown'
                    });

                    req.session.challengeId = challengeId;
                    return res.redirect('/admin/verify-otp');
                    
                } catch(e) {
                    // Strict mode: do not bypass login when OTP sending fails.
                    return res.send(`
                        <script>
                            alert('❌ Telegram OTP ပို့ရန် အခက်အခဲရှိနေပါသည်။\\nBot Token / Chat ID ကို ပြန်စစ်ပြီး ထပ်မံကြိုးစားပါ။');
                            window.location.href='/admin/login';
                        </script>
                    `);
                }
            } else {
                // No Bot setup, login directly
                req.session.isAdmin = true;
                return res.redirect('/admin');
            }
        } else {
            res.send(`<script>alert('❌ Invalid Username or Password!'); window.history.back();</script>`);
        }
    } catch(e) { 
        res.status(500).send("Login Error: " + e.message); // 🌟 Added detail for debugging
    }
});

// OTP Page UI
adminApp.get('/verify-otp', (req, res) => {
    if (!req.session || !req.session.challengeId) {
        return res.redirect('/admin/login');
    }
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>2FA Verification - QITO</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        </head>
        <body class="bg-slate-900 h-screen flex items-center justify-center p-4">
            <div class="bg-slate-800 p-8 rounded-3xl shadow-2xl border border-slate-700 w-full max-w-md text-center">
                <div class="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto mb-5 border border-blue-500/50">
                    <i class="fab fa-telegram-plane text-blue-400 text-3xl"></i>
                </div>
                <h2 class="text-2xl font-black text-white mb-2">Verification Required</h2>
                <p class="text-slate-400 text-sm mb-8">We've sent a 6-digit OTP to your Backup Telegram Bot. Please enter it below.</p>
                
                <form action="/admin/verify-otp" method="POST">
                    <input type="text" name="otp" placeholder="• • • • • •" required maxlength="6" class="w-full bg-slate-900 border border-slate-700 text-white text-center text-2xl tracking-[0.5em] px-4 py-4 rounded-xl outline-none focus:border-blue-500 transition mb-6 font-mono">
                    <button type="submit" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl transition shadow-[0_4px_15px_rgba(37,99,235,0.3)]">Verify OTP</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

// Process OTP
adminApp.post('/verify-otp', async (req, res) => {
    try {
        const { otp } = req.body;
        const challengeId = req.session.challengeId;
        if (!challengeId) return res.redirect('/admin/login');

        const storedOtp = await redisClient.get(`otp:${challengeId}`);
        if (!storedOtp) {
            return res.send(`<script>alert('❌ OTP Expired or Invalid Challenge. Please login again.'); window.location.href='/admin/login';</script>`);
        }

        if (storedOtp === otp) {
            await redisClient.del(`otp:${challengeId}`); 
            req.session.isAdmin = true;
            delete req.session.challengeId;
            return res.redirect('/admin');
        } else {
            res.send(`<script>alert('❌ Incorrect OTP!'); window.history.back();</script>`);
        }
    } catch(e) { 
        res.status(500).send("OTP Error: " + e.message); 
    }
});

// Logout
adminApp.get('/logout', (req, res) => {
    if (req.session) {
        req.session.destroy();
    }
    res.redirect('/admin/login');
});


// ==========================================
// 🛡️ 3. SECURITY MIDDLEWARE (PROTECTS ALL ROUTES BELOW)
// ==========================================
adminApp.use((req, res, next) => {
    // 1. Check Web Session
    if (req.session && req.session.isAdmin) {
        return next();
    }
    // 2. Check API Key for Master Server communications
    if (req.headers['x-api-key']) {
        return next(); 
    }
    // Deny access
    res.redirect('/admin/login');
});


// ==========================================
// 🌟 Telegram Auto Backup Manager 
// ==========================================
let backupIntervalId = null;

async function startTelegramAutoBackup() {
    if (backupIntervalId) {
        clearInterval(backupIntervalId);
    }
    try {
        const setting = await Setting.findOne({});
        if (!setting || !setting.botToken || !setting.adminId || !setting.backupIntervalMinutes) {
            console.log("⚠️ Telegram Auto-Backup is disabled.");
            return;
        }

        initTelegramBot(setting.botToken, setting.adminId);
        const intervalMs = setting.backupIntervalMinutes * 60 * 1000;
        
        backupIntervalId = setInterval(async () => {
            await sendAutoBackupDocument(setting.adminId);
        }, intervalMs);
    } catch (err) {
        console.error("Auto Backup Init Error:", err);
    }
}
setTimeout(startTelegramAutoBackup, 3000);


// ==========================================
// 🌟 Secure Fetch Utility (Handles 401 Loop)
// ==========================================
async function fetchWithRetry(url, data, config, retries = 3, delay = 1000) {
    const method = (config && config.method) ? config.method.toLowerCase() : 'post';
    
    if (!config) config = {};
    if (!config.headers) config.headers = {};
    config.headers['Content-Type'] = 'application/json'; 

    for (let i = 0; i < retries; i++) {
        try {
            if (method === 'get') {
                return await axios.get(url, config);
            } else {
                return await axios.post(url, data || {}, config); 
            }
        } catch (err) {
            if (err.response && err.response.status === 401) {
                console.error("⛔️ API Key Error (401). Stopping retries for URL:", url);
                throw err; 
            }
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, delay * Math.pow(2, i))); 
        }
    }
}

function getErrMsg(err) {
    if (!err) return 'Unknown error';
    if (err.response && err.response.data) {
        const d = err.response.data;
        if (typeof d === 'string') return d;
        if (d.error) return String(d.error);
        if (d.message) return String(d.message);
        try { return JSON.stringify(d); } catch (e) {}
    }
    return err.message || String(err);
}

function pickKeysFromResponsePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.keys && typeof payload.keys === 'object') return payload.keys;
    if (payload.data && payload.data.keys && typeof payload.data.keys === 'object') return payload.data.keys;
    if (payload.user && payload.user.keys && typeof payload.user.keys === 'object') return payload.user.keys;
    return null;
}

function normalizeMasterBaseUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }
    return url.replace(/\/$/, '');
}

function normalizeHost(value) {
    const raw = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!raw) return '';
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    return withoutScheme.split('/')[0].replace(/:\d+$/, '').trim().replace(/\.$/, '');
}

function buildServerLabels(accessKeys, existingLabels) {
    const labels = {};
    const source = (existingLabels && typeof existingLabels === 'object') ? existingLabels : {};
    const keys = (accessKeys && typeof accessKeys === 'object') ? Object.keys(accessKeys) : [];
    for (const key of keys) {
        const oldLabel = source[key];
        labels[key] = (oldLabel && String(oldLabel).trim()) ? String(oldLabel).trim() : key;
    }
    return labels;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return value;
    }
}

function buildGroupNodeTemplateMap(users) {
    const templates = {};
    for (const user of users) {
        if (!user || !isPlainObject(user.accessKeys)) continue;
        for (const [nodeKey, cfg] of Object.entries(user.accessKeys)) {
            if (!nodeKey || templates[nodeKey] !== undefined) continue;
            templates[nodeKey] = cloneValue(cfg);
        }
    }
    return templates;
}

function buildNodeConfigForUser(user, templateConfig) {
    const template = cloneValue(templateConfig);
    if (!isPlainObject(template)) return template;
    const ownKeys = isPlainObject(user && user.accessKeys) ? Object.values(user.accessKeys) : [];
    const ownBase = ownKeys.find((v) => isPlainObject(v));
    if (!ownBase) return template;

    // Keep per-user credentials from existing keys while borrowing node host/port from template.
    const carryFields = ['password', 'method', 'prefix', 'id', 'flow', 'encryption', 'security', 'plugin', 'plugin_opts'];
    for (const f of carryFields) {
        if (ownBase[f] !== undefined) template[f] = ownBase[f];
    }
    return template;
}

function normalizeNodeIdFromMasterEntry(n, fallbackId = '') {
    if (typeof n === 'string') return String(n).trim();
    if (n !== null && typeof n !== 'object') return String(fallbackId || '').trim();
    if (!n || typeof n !== 'object') return '';
    const id = n.id || n.serverId || n.nodeId || n.key || fallbackId || n.name || n.serverName || n.nodeName || '';
    return String(id || '').trim();
}

function extractNodeIdSetFromMasterGroup(groupObj) {
    if (!groupObj || typeof groupObj !== 'object') return new Set();
    const rawNodes =
        groupObj.activeNodes ??
        groupObj.nodes ??
        groupObj.servers ??
        groupObj.serverList ??
        groupObj.activeNodeList ??
        groupObj.onlineNodes ??
        groupObj.nodeList;
    const ids = new Set();
    if (Array.isArray(rawNodes)) {
        for (const n of rawNodes) {
            const id = normalizeNodeIdFromMasterEntry(n);
            if (id) ids.add(id);
        }
    } else if (rawNodes && typeof rawNodes === 'object') {
        for (const [k, v] of Object.entries(rawNodes)) {
            const id = normalizeNodeIdFromMasterEntry(v, k);
            if (id) ids.add(id);
        }
    } else if (typeof rawNodes === 'string' && rawNodes.trim()) {
        for (const s of rawNodes.split(',')) {
            const id = String(s || '').trim();
            if (id) ids.add(id);
        }
    }
    return ids;
}

async function syncGroupUsersFromMaster(groupInfo, opts = {}) {
    if (!groupInfo || !groupInfo.masterIp) throw new Error('Invalid group master setup.');
    if (!groupInfo.masterGroupId) throw new Error('Missing masterGroupId for this group.');

    const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;
    const users = await User.find({ groupName: groupInfo.name });
    const throttleMs = Number(opts.throttleMs) > 0 ? Number(opts.throttleMs) : 5000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let syncedUsers = 0;
    let failedUsers = 0;
    let skippedExisting = 0;

    // Step 1: Throttled generate-keys — one user at a time, 5s gap for xray to settle.
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        try {
            const masterResponse = await fetchWithRetry(groupInfo.masterIp + '/api/generate-keys', {
                masterGroupId: groupInfo.masterGroupId,
                userName: user.name,
                totalGB: user.totalGB,
                expireDate: user.expireDate,
            }, { headers: { 'x-api-key': apiKeyHeader }, timeout: 12000 }, 1, 500);

            const masterKeys = pickKeysFromResponsePayload(masterResponse && masterResponse.data ? masterResponse.data : masterResponse);
            if (masterKeys && typeof masterKeys === 'object' && Object.keys(masterKeys).length > 0) {
                const updateQuery = {
                    accessKeys: masterKeys,
                    serverLabels: buildServerLabels(masterKeys, user.serverLabels)
                };
                if (!user.currentServer || user.currentServer === 'None' || !masterKeys[user.currentServer]) {
                    updateQuery.currentServer = Object.keys(masterKeys)[0] || 'None';
                }
                await User.updateOne({ _id: user._id }, { $set: updateQuery });
                try { await redisClient.del(user.token); } catch (e) {}
            }
            syncedUsers++;
            console.log(`[sync] generate-keys OK for ${user.name} (${i + 1}/${users.length})`);

            // Restore usedGB from backup so Master tracks actual usage (not reset to 0).
            if (user.usedGB > 0) {
                await sleep(1000);
                try {
                    await fetchWithRetry(groupInfo.masterIp + '/api/internal/edit-user', {
                        username: user.name,
                        usedGB: user.usedGB
                    }, { headers: { 'x-api-key': apiKeyHeader }, timeout: 5000 }, 1, 500);
                    console.log(`[sync] restored usedGB=${user.usedGB} for ${user.name}`);
                } catch (e) {
                    console.log(`[sync] edit-user usedGB failed for ${user.name}: ${getErrMsg(e)}`);
                }
            }
        } catch (err) {
            const status = err && err.response && err.response.status;
            if (status === 400) {
                skippedExisting++;
                console.log(`[sync] user already exists on master: ${user.name} (${i + 1}/${users.length})`);
            } else {
                failedUsers++;
                console.log(`[sync] generate-keys failed for ${user.name}: ${getErrMsg(err)}`);
            }
        }
        if (i < users.length - 1) await sleep(throttleMs);
    }

    // Step 2: Local backfill — fill missing nodes from group peers (no Master call).
    const allNodeKeys = {};
    const freshUsers = await User.find({ groupName: groupInfo.name });
    for (const u of freshUsers) {
        if (u.accessKeys && typeof u.accessKeys === 'object') {
            for (const [nodeKey, cfg] of Object.entries(u.accessKeys)) {
                if (!nodeKey || allNodeKeys[nodeKey]) continue;
                try { allNodeKeys[nodeKey] = JSON.parse(JSON.stringify(cfg)); } catch (e) { allNodeKeys[nodeKey] = cfg; }
            }
        }
    }
    for (const user of freshUsers) {
        try {
            const existing = (user.accessKeys && typeof user.accessKeys === 'object') ? { ...user.accessKeys } : {};
            let changed = false;
            for (const [nodeKey, templateCfg] of Object.entries(allNodeKeys)) {
                if (existing[nodeKey] !== undefined) continue;
                existing[nodeKey] = buildNodeConfigForUser(user, templateCfg);
                changed = true;
            }
            if (changed) {
                await User.updateOne({ _id: user._id }, {
                    $set: {
                        accessKeys: existing,
                        serverLabels: buildServerLabels(existing, user.serverLabels),
                        ...( (!user.currentServer || !existing[user.currentServer]) ? { currentServer: Object.keys(existing)[0] || 'None' } : {} )
                    }
                });
                try { await redisClient.del(user.token); } catch (e) {}
            }
        } catch (e) {}
    }

    return {
        groupName: groupInfo.name,
        totalUsers: users.length,
        syncedUsers,
        failedUsers,
        skippedExisting,
        expectedNodeCount: Object.keys(allNodeKeys).length
    };
}


// ==========================================
// 🌟 Common UI Components
// ==========================================
const getNavbar = (title = "QITO <span class='text-indigo-400 font-light ml-1'>ADMIN</span>") => `
    <nav class="bg-gradient-to-r from-slate-900 via-indigo-900 to-slate-900 text-white shadow-xl p-4 mb-8 sticky top-0 z-40">
        <div class="max-w-7xl mx-auto flex items-center justify-between gap-4">
            <a href="/admin" class="font-black text-xl md:text-2xl tracking-tight flex items-center shrink-0 transition hover:scale-105">
                <div class="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center mr-3 border border-indigo-400/30">
                    <i class="fas fa-shield-alt text-indigo-400"></i>
                </div>
                <span class="hidden sm:inline">${title}</span>
            </a>
            
            <div class="flex-1 flex justify-center">
                <form action="/admin/search" method="POST" class="w-full max-w-lg relative group">
                    <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        <i class="fas fa-search text-slate-400 group-focus-within:text-indigo-400 transition"></i>
                    </div>
                    <input type="text" name="query" placeholder="Search by ssconf link or Token..." required class="w-full bg-slate-800/50 border border-slate-700 text-white text-sm rounded-2xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block pl-10 p-3 transition-all outline-none placeholder-slate-400 shadow-inner">
                    <button type="submit" class="absolute inset-y-0 right-0 pr-4 flex items-center text-xs font-bold text-indigo-400 hover:text-indigo-300 transition">FIND</button>
                </form>
            </div>
            
            <div class="flex items-center gap-3">
                <a href="/admin/settings" class="shrink-0 w-11 h-11 flex items-center justify-center bg-slate-800/50 hover:bg-indigo-500/30 rounded-xl border border-slate-700 transition-all duration-300" title="Settings">
                    <i class="fas fa-cog text-slate-300"></i>
                </a>
                <a href="/admin/logout" class="shrink-0 w-11 h-11 flex items-center justify-center bg-red-500/20 hover:bg-red-500/40 rounded-xl border border-red-500/30 transition-all duration-300" title="Logout">
                    <i class="fas fa-sign-out-alt text-red-400"></i>
                </a>
            </div>
        </div>
    </nav>
`;

const getLoadingModal = () => `
    <div id="loadingModal" class="fixed inset-0 z-[100] hidden items-center justify-center bg-slate-900/80 backdrop-blur-sm">
        <div class="bg-white p-8 rounded-3xl flex flex-col items-center shadow-2xl transform scale-105 transition-transform">
            <i class="fas fa-circle-notch fa-spin text-indigo-600 text-5xl mb-4"></i>
            <p class="text-slate-800 font-black tracking-wide text-lg mt-4">Processing...</p>
            <p class="text-slate-500 text-xs font-bold mt-1">Please wait, do not close.</p>
        </div>
    </div>
`;

const getUploadScript = () => `
    <script>
        function triggerUpload(type, expectedGroup = null) {
            const input = document.createElement('input'); 
            input.type = 'file'; 
            input.accept = '.json';
            
            input.onchange = e => {
                const file = e.target.files[0]; 
                if(!file) return;
                
                document.getElementById('loadingModal').classList.remove('hidden'); 
                document.getElementById('loadingModal').classList.add('flex');
                
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const jsonData = JSON.parse(ev.target.result);
                        const res = await fetch('/admin/api/restore-upload', { 
                            method: 'POST', 
                            headers: {'Content-Type': 'application/json'}, 
                            body: JSON.stringify({ data: jsonData, expectedGroup }) 
                        });
                        const result = await res.json();
                        
                        if(result.success) { 
                            alert('✅ Backup File ပြန်လည်ထည့်သွင်းခြင်း အောင်မြင်ပါသည်!'); 
                            window.location.reload(); 
                        } else { 
                            alert('❌ Error: ' + result.error); 
                            document.getElementById('loadingModal').classList.add('hidden'); 
                            document.getElementById('loadingModal').classList.remove('flex'); 
                        }
                    } catch(err) {
                        alert('❌ Invalid JSON File! ဖိုင်အမျိုးအစား မှားယွင်းနေပါသည်။'); 
                        document.getElementById('loadingModal').classList.add('hidden'); 
                        document.getElementById('loadingModal').classList.remove('flex');
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        }
    </script>
`;


// ==========================================
// 🌟 4. HOME DASHBOARD ROUTE
// ==========================================
adminApp.get('/', async (req, res) => {
    const groups = await Group.find({});
    const masters = await Master.find({}); 
    
    let groupsHtml = '';
    for (const g of groups) {
        const userCount = await User.countDocuments({ groupName: g.name });
        groupsHtml += `
        <div class="bg-white rounded-3xl shadow-sm hover:shadow-xl transition-all duration-300 border border-slate-100 overflow-hidden flex flex-col hover:-translate-y-1">
            <div class="bg-gradient-to-r from-slate-800 to-slate-700 p-5 flex justify-between items-center">
                <h3 class="text-lg font-black text-white flex items-center">
                    <i class="fas fa-server text-indigo-400 mr-2 drop-shadow-md"></i> ${g.name} 
                    <span class="ml-3 text-[10px] font-black bg-indigo-500 text-white px-2 py-1 rounded-md shadow-sm border border-indigo-400 uppercase tracking-widest">${g.masterName || 'API-1'}</span>
                </h3>
                <button type="button" onclick="openDoubleConfirmModal('${g.name}')" class="text-white hover:text-red-400 bg-white/10 hover:bg-white/20 p-2.5 rounded-xl transition">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
            <div class="p-6 flex-1">
                <div class="flex items-center justify-between mb-4 border-b border-slate-50 pb-4">
                    <span class="text-xs text-slate-400 font-bold uppercase tracking-wider">Master IP</span>
                    <span class="text-sm font-bold text-slate-700 truncate w-32 text-right">${g.masterIp || 'N/A'}</span>
                </div>
                <div class="flex items-center justify-between mb-5">
                    <span class="text-xs text-slate-400 font-bold uppercase tracking-wider">Custom DNS</span>
                    <span class="text-sm font-bold text-indigo-600 truncate max-w-[150px]">${g.nsRecord || 'N/A'}</span>
                </div>
                <div class="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <span class="text-xs text-slate-500 font-bold uppercase tracking-wider">Active Users</span>
                    <span class="text-2xl font-black text-slate-800">${userCount}</span>
                </div>
            </div>
            <div class="p-4 bg-slate-50 border-t border-slate-100">
                <a href="/admin/group/${encodeURIComponent(g.name)}" class="flex items-center justify-center w-full bg-indigo-600 text-white font-bold py-3.5 rounded-2xl hover:bg-indigo-700 shadow-[0_4px_15px_rgba(79,70,229,0.3)] hover:shadow-[0_6px_20px_rgba(79,70,229,0.4)] transition-all active:scale-[0.98]">
                    Manage Group <i class="fas fa-arrow-right ml-2"></i>
                </a>
            </div>
        </div>`;
    }

    let masterOptions = '<option value="" disabled selected>Select a saved Master API...</option>';
    let mastersListHtml = '';
    
    masters.forEach((m) => {
        masterOptions += `<option value="${m.ip}|${m.apiKey}|${m.name}">${m.name} (${m.ip})</option>`;
        mastersListHtml += `
            <div class="flex justify-between items-center bg-slate-50 p-3 rounded-xl border border-slate-100 mb-2 hover:shadow-md transition">
                <div>
                    <span class="font-bold text-slate-700 bg-slate-200 px-2 py-1 rounded text-xs mr-2">${m.name}</span>
                    <span class="text-sm font-semibold text-slate-600">${m.ip}</span>
                </div>
                <form action="/admin/delete-master" method="POST" onsubmit="return confirm('ဖျက်မှာ သေချာလား?');" class="m-0">
                    <input type="hidden" name="id" value="${m._id}">
                    <button type="submit" class="text-red-500 hover:text-red-700 bg-red-50 p-2 rounded-lg transition hover:bg-red-100">
                        <i class="fas fa-trash"></i>
                    </button>
                </form>
            </div>`;
    });

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QITO Tech Admin Panel</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
            <style>
                @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
                .delay-100 { animation-delay: 0.1s; }
                .delay-200 { animation-delay: 0.2s; }
            </style>
        </head>
        <body class="bg-[#f8fafc] font-sans pb-10 selection:bg-indigo-500 selection:text-white">
            
            ${getNavbar()}
            ${getLoadingModal()}

            <div class="max-w-7xl mx-auto px-4">
                
                <div class="bg-white p-7 rounded-[2rem] shadow-sm border border-slate-200 flex flex-col md:flex-row gap-6 mb-10 animate-fade-in-up">
                    <div class="flex-1 border-r border-slate-100 pr-0 md:pr-6">
                        <label class="block text-lg font-black text-slate-800 mb-5 flex items-center">
                            <i class="fas fa-key text-yellow-500 mr-2 text-xl drop-shadow"></i> Save Master API
                        </label>
                        <form action="/admin/add-master" method="POST" class="grid grid-cols-1 gap-3">
                            <input type="text" name="name" placeholder="Name (e.g., API-1)" required class="border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-800 transition">
                            <input type="text" name="ip" placeholder="URL (https://dash.datthabaluu.me)" required class="border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-800 transition">
                            <input type="password" name="apiKey" placeholder="API Key" required class="border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-800 transition">
                            <button type="submit" class="mt-2 bg-slate-800 text-white py-4 rounded-2xl font-bold hover:bg-black transition shadow-md active:scale-[0.98]">
                                <i class="fas fa-save mr-2"></i> Save API
                            </button>
                        </form>
                    </div>
                    <div class="flex-1 pl-0 md:pl-2">
                        <label class="block text-xs font-black text-slate-400 mb-3 uppercase tracking-widest">Saved APIs</label>
                        <div class="max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                            ${mastersListHtml || '<p class="text-sm text-slate-400 italic">No APIs saved yet.</p>'}
                        </div>
                        
                        ${masters.length > 0 ? `
                        <form action="/admin/delete-all-masters" method="POST" onsubmit="return confirm('API အဟောင်းများ အားလုံးကို ရှင်းထုတ်မှာ သေချာလား?');" class="mt-4 m-0">
                            <button type="submit" class="w-full bg-red-50 text-red-500 hover:bg-red-500 hover:text-white font-bold py-3 rounded-xl border border-red-100 transition shadow-sm text-sm flex items-center justify-center">
                                <i class="fas fa-trash-alt mr-2"></i> Clear All Saved APIs
                            </button>
                        </form>
                        ` : ''}
                    </div>
                </div>

                <div class="bg-white p-8 rounded-[2rem] shadow-md border border-slate-200 mb-10 animate-fade-in-up delay-100">
                    <label class="block text-xl font-black text-slate-800 mb-6 flex items-center">
                        <i class="fas fa-network-wired text-indigo-500 mr-3 text-2xl drop-shadow"></i> Create New Group
                    </label>
                    <div class="flex flex-col md:flex-row gap-4 mb-8 pb-8 border-b border-slate-100">
                        <div class="flex-1">
                            <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Select Master API</label>
                            <select id="savedMasterSelector" class="w-full border-2 border-indigo-200 bg-indigo-50/50 p-4 rounded-2xl outline-none focus:border-indigo-500 font-bold text-indigo-900 transition hover:bg-indigo-50">
                                ${masterOptions}
                            </select>
                        </div>
                        <div class="flex items-end">
                            <button type="button" onclick="fetchGroupsFromSaved()" id="fetchBtn" class="w-full md:w-auto bg-indigo-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-indigo-700 transition shadow-[0_4px_15px_rgba(79,70,229,0.3)] active:scale-[0.98]">
                                <i class="fas fa-sync-alt mr-2"></i> Fetch Groups
                            </button>
                        </div>
                    </div>

                    <form action="/admin/create-group" method="POST" class="grid grid-cols-1 md:grid-cols-5 gap-5">
                        <input type="hidden" name="masterIp" id="formMasterIp">
                        <input type="hidden" name="masterApiKey" id="formMasterApiKey">
                        <input type="hidden" name="masterName" id="formMasterName">
                        
                        <div>
                            <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">1. Select Group</label>
                            <select name="masterGroupId" id="masterGroupSelect" required class="w-full border-2 border-slate-200 bg-slate-50 p-4 rounded-2xl outline-none focus:border-indigo-500 font-bold text-slate-700 transition">
                                <option value="" disabled selected>Fetch groups first...</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">2. Local Name</label>
                            <input type="text" name="groupName" placeholder="e.g. VIP Gaming" required class="w-full border-2 border-slate-200 p-4 rounded-2xl outline-none focus:border-indigo-500 font-bold text-slate-800 transition">
                        </div>
                        <div>
                            <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">3. Custom DNS</label>
                            <input type="text" name="nsRecord" placeholder="e.g. ns1.domain.com" required class="w-full border-2 border-slate-200 p-4 rounded-2xl outline-none focus:border-indigo-500 font-bold text-indigo-700 transition">
                        </div>
                        <div>
                            <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">4. Panel Badge</label>
                            <input type="text" name="panelLabel" placeholder="e.g. Premium, VIP, Gold" class="w-full border-2 border-slate-200 p-4 rounded-2xl outline-none focus:border-indigo-500 font-bold text-slate-800 transition">
                        </div>
                        <div class="flex items-end">
                            <button type="submit" class="w-full bg-slate-800 text-white px-6 py-4 rounded-2xl font-bold hover:bg-black transition shadow-md active:scale-[0.98]">
                                <i class="fas fa-plus mr-2"></i> Create Group
                            </button>
                        </div>
                    </form>
                </div>
                
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-fade-in-up delay-200">
                    ${groupsHtml || '<div class="col-span-full bg-white rounded-3xl p-10 text-center border border-slate-200 shadow-sm"><i class="fas fa-folder-open text-4xl text-slate-300 mb-3 block"></i><p class="text-slate-500 font-bold">No groups found. Create one above!</p></div>'}
                </div>
            </div>

            <div id="deleteGroupModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/60 backdrop-blur-sm transition-opacity opacity-0 duration-300">
                <div class="bg-white rounded-[2rem] p-8 w-full max-w-sm shadow-2xl border border-red-100 transform scale-95 transition-transform duration-300" id="deleteModalContent">
                    <div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-5 border-4 border-red-50">
                        <i class="fas fa-exclamation-triangle text-red-500 text-3xl animate-pulse"></i>
                    </div>
                    <div class="text-center">
                        <h3 class="text-2xl font-black text-slate-800 mb-2">WARNING!</h3>
                        <p class="text-slate-500 text-sm font-semibold mb-6">
                            Are you absolutely sure you want to delete <br>
                            <b id="deleteModalGroupName" class="text-red-600 text-lg block mt-1">Group</b>? <br><br>
                            <span class="text-xs text-red-400">All users in this group will also be permanently deleted!</span>
                        </p>
                        <form action="/admin/delete-group" method="POST" class="flex flex-col gap-3">
                            <input type="hidden" name="groupName" id="deleteGroupNameInput">
                            <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-black py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(220,38,38,0.4)] active:scale-[0.98]">
                                YES, DELETE FOREVER
                            </button>
                            <button type="button" onclick="closeDoubleConfirmModal()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold py-3.5 rounded-2xl transition active:scale-[0.98]">
                                Cancel
                            </button>
                        </form>
                    </div>
                </div>
            </div>

            <script>
                async function fetchGroupsFromSaved() {
                    const selector = document.getElementById('savedMasterSelector').value; 
                    const btn = document.getElementById('fetchBtn');
                    
                    if(!selector) return alert("Please select a Master API!");
                    
                    const [ip, key, name] = selector.split('|'); 
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Fetching...';
                    
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 12000);
                        const res = await fetch('/admin/api/fetch-master-groups', { 
                            method: 'POST', 
                            headers: { 'Content-Type': 'application/json' },
                            signal: controller.signal,
                            body: JSON.stringify({ masterIp: ip, masterApiKey: key }) 
                        });
                        clearTimeout(timeoutId);

                        if (!res.ok) {
                            throw new Error('Server returned ' + res.status);
                        }
                        const data = await res.json();
                        
                        if(data.success) {
                            let options = '<option value="" disabled selected>Select from Master...</option>';
                            data.groups.forEach(g => { 
                                options += \`<option value="\${g.id}">\${g.name} (\${g.serverCount} Nodes)</option>\`; 
                            });
                            
                            document.getElementById('masterGroupSelect').innerHTML = options; 
                            document.getElementById('masterGroupSelect').classList.remove('bg-slate-50');
                            document.getElementById('masterGroupSelect').classList.add('bg-white', 'border-indigo-300');
                            
                            document.getElementById('formMasterIp').value = ip; 
                            document.getElementById('formMasterApiKey').value = key; 
                            document.getElementById('formMasterName').value = name;
                            
                            btn.innerHTML = '<i class="fas fa-check mr-2"></i> Connected!'; 
                            btn.classList.replace('bg-indigo-600', 'bg-green-500'); 
                            
                            setTimeout(() => { 
                                btn.innerHTML = '<i class="fas fa-sync-alt mr-2"></i> Fetch Groups'; 
                                btn.classList.replace('bg-green-500', 'bg-indigo-600'); 
                            }, 2000);
                        } else { 
                            alert("Failed: " + data.error); 
                        }
                    } catch(e) { 
                        const msg = e && e.name === 'AbortError' ? "Request timeout. Check Master URL / API Key and network." : (e.message || "Network Error!");
                        alert("Failed: " + msg);
                    } finally {
                        if (!btn.innerHTML.includes('Connected!')) {
                            btn.innerHTML = '<i class="fas fa-sync-alt mr-2"></i> Fetch Groups';
                        }
                    }
                }

                function openDoubleConfirmModal(groupName) {
                    document.getElementById('deleteGroupNameInput').value = groupName; 
                    document.getElementById('deleteModalGroupName').innerText = groupName;
                    
                    const modal = document.getElementById('deleteGroupModal'); 
                    const content = document.getElementById('deleteModalContent');
                    
                    modal.classList.remove('hidden'); 
                    modal.classList.add('flex');
                    setTimeout(() => { 
                        modal.classList.remove('opacity-0'); 
                        content.classList.remove('scale-95'); 
                    }, 10);
                }

                function closeDoubleConfirmModal() {
                    const modal = document.getElementById('deleteGroupModal'); 
                    const content = document.getElementById('deleteModalContent');
                    
                    modal.classList.add('opacity-0'); 
                    content.classList.add('scale-95');
                    setTimeout(() => { 
                        modal.classList.add('hidden'); 
                        modal.classList.remove('flex'); 
                    }, 300);
                }
            </script>
        </body>
        </html>
    `);
});

// ==========================================
// 🌟 5. SETTINGS & BACKUP ROUTE
// ==========================================
adminApp.get('/settings', async (req, res) => {
    let fullBackups = [];
    let groupBackups = [];
    
    if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort().reverse();
        files.forEach(f => {
            if (f.startsWith('Full_Backup')) fullBackups.push(f);
            else if (f.startsWith('Group_')) groupBackups.push(f);
        });
    }

    let setting = await Setting.findOne({});
    if (!setting) {
        setting = { botToken: '', adminId: '', backupIntervalMinutes: 60, adminUsername: 'admin' };
    }

    const renderBackupItem = (b, type) => {
        const dateMatch = b.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1].replace('_', ' at ').replace(/-/g, ':').replace(/:/, '-').replace(/:/, '-') : 'Unknown Date';
        const badgeColor = type === 'full' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700';
        
        return `
        <div class="flex justify-between items-center bg-slate-50 p-4 rounded-2xl mb-3 border border-slate-100 hover:border-indigo-200 transition-all duration-300">
            <div>
                <div class="flex items-center gap-2 mb-1">
                    <span class="${badgeColor} px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest shadow-sm">${type}</span>
                    <span class="text-sm font-bold text-slate-700">${b}</span>
                </div>
                <div class="text-[11px] text-slate-500 font-semibold"><i class="far fa-clock mr-1"></i> ${dateStr} (MMT)</div>
            </div>
            <div class="flex gap-2">
                <a href="/admin/download-backup/${encodeURIComponent(b)}" class="bg-white border border-slate-200 text-slate-600 hover:text-indigo-600 hover:border-indigo-300 px-3 py-2 rounded-xl text-sm font-bold transition shadow-sm" title="Download to PC">
                    <i class="fas fa-download"></i>
                </a>
                <button type="button" onclick="triggerUpload('${type}')" class="bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white px-3 py-2 rounded-xl text-sm font-bold transition shadow-sm" title="Restore this file">
                    <i class="fas fa-undo"></i>
                </button>
                <form action="/admin/delete-backup" method="POST" onsubmit="return confirm('ဖျက်မှာ သေချာလား?');" class="m-0">
                    <input type="hidden" name="filename" value="${b}">
                    <button type="submit" class="bg-red-50 text-red-500 hover:bg-red-600 hover:text-white px-3 py-2 rounded-xl text-sm font-bold transition shadow-sm" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </form>
            </div>
        </div>`;
    };

    let fullHtml = fullBackups.length > 0 ? fullBackups.map(b => renderBackupItem(b, 'full')).join('') : '<p class="text-slate-400 text-sm p-4 text-center">No Full Backups Found.</p>';
    let groupHtml = groupBackups.length > 0 ? groupBackups.map(b => renderBackupItem(b, 'group')).join('') : '<p class="text-slate-400 text-sm p-4 text-center">No Group Backups Found.</p>';

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Settings & Backups - QITO Tech</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
            <style>
                @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
            </style>
        </head>
        <body class="bg-[#f8fafc] font-sans pb-10">
            
            ${getNavbar("System <span class='text-indigo-400 font-light ml-1'>SETTINGS</span>")}
            ${getLoadingModal()}

            <div class="max-w-6xl mx-auto px-4 animate-fade-in-up">
                <div class="mb-8">
                    <h2 class="text-3xl font-black text-slate-800"><i class="fas fa-cog text-indigo-500 mr-3"></i> System Settings</h2>
                    <p class="text-slate-500 font-semibold mt-2">Manage your admin profile, telegram automation, and backups.</p>
                </div>

                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    
                    <div class="bg-white p-6 md:p-8 rounded-[2rem] shadow-sm border border-slate-200">
                        <div class="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
                            <h3 class="text-xl font-black text-slate-800"><i class="fas fa-user-shield text-red-500 mr-2"></i> Admin Security</h3>
                        </div>
                        <form action="/admin/change-credentials" method="POST" class="grid grid-cols-1 gap-5 mb-6">
                            <div>
                                <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Admin Username</label>
                                <input type="text" name="username" value="${setting.adminUsername}" required class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-red-500 font-bold text-sm text-slate-700 transition">
                            </div>
                            <div>
                                <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">New Password (Optional)</label>
                                <input type="password" name="newPassword" placeholder="Leave blank to keep current" class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-red-500 font-bold text-sm text-slate-700 transition">
                            </div>
                            <div class="flex gap-3">
                                <button type="submit" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(220,38,38,0.3)] active:scale-[0.98]">
                                    <i class="fas fa-key mr-2"></i> Update Login Info
                                </button>
                            </div>
                        </form>
                        <form action="/admin/backfill-server-labels" method="POST" class="m-0 pt-5 border-t border-slate-100">
                            <button type="submit" class="w-full bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold py-3.5 rounded-2xl transition active:scale-[0.98]">
                                <i class="fas fa-tags mr-2"></i> Backfill Server Display Names
                            </button>
                            <p class="text-[11px] text-slate-500 mt-2 font-semibold">Fills missing node display labels for old users without changing keys.</p>
                        </form>
                    </div>

                    <div class="bg-white p-6 md:p-8 rounded-[2rem] shadow-sm border border-slate-200">
                        <div class="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
                            <h3 class="text-xl font-black text-slate-800"><i class="fab fa-telegram text-blue-500 mr-2"></i> Telegram & 2FA Setup</h3>
                        </div>
                        <form action="/admin/save-telegram-settings" method="POST" class="grid grid-cols-1 gap-5 mb-6">
                            <div>
                                <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Bot Token (Enables 2FA & Backups)</label>
                                <input type="text" name="botToken" value="${setting.botToken}" placeholder="123456:ABC-DEF1234gh..." class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-blue-500 font-mono text-sm text-slate-700 transition">
                            </div>
                            <div class="flex gap-4">
                                <div class="flex-1">
                                    <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Admin Chat ID</label>
                                    <input type="text" name="adminId" value="${setting.adminId}" class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-blue-500 font-mono text-sm text-slate-700 transition">
                                </div>
                                <div class="w-32">
                                    <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Interval (Min)</label>
                                    <input type="number" name="backupIntervalMinutes" value="${setting.backupIntervalMinutes}" min="1" class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-blue-500 font-bold text-sm text-slate-700 transition">
                                </div>
                            </div>
                            <div class="flex gap-3">
                                <button type="submit" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(37,99,235,0.3)] active:scale-[0.98]">
                                    <i class="fas fa-save mr-2"></i> Save Telegram Config
                                </button>
                            </div>
                        </form>
                    </div>

                    <div class="bg-white p-6 md:p-8 rounded-[2rem] shadow-sm border border-slate-200">
                        <div class="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
                            <h3 class="text-xl font-black text-slate-800"><i class="fas fa-globe text-purple-500 mr-2"></i> Full System Backups</h3>
                        </div>
                        <div class="flex gap-3 mb-6">
                            <form action="/admin/backup-all" method="POST" class="flex-1 m-0">
                                <button type="submit" class="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(147,51,234,0.3)] active:scale-[0.98]">
                                    <i class="fas fa-plus-circle mr-2"></i> Create
                                </button>
                            </form>
                            <button type="button" onclick="triggerUpload('full')" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3.5 rounded-2xl transition active:scale-[0.98]">
                                <i class="fas fa-upload mr-2"></i> Upload
                            </button>
                        </div>
                        <div class="border-t border-slate-100 pt-6 mb-6">
                            <form action="/admin/send-telegram-backup" method="POST" class="m-0" onsubmit="document.getElementById('loadingModal').classList.replace('hidden', 'flex');">
                                <button type="submit" class="w-full bg-slate-800 hover:bg-black text-white font-bold py-3.5 rounded-2xl transition shadow-md active:scale-[0.98]">
                                    <i class="fas fa-paper-plane mr-2"></i> Send Full Backup to Telegram Now
                                </button>
                            </form>
                        </div>
                        <div class="max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                            ${fullHtml}
                        </div>
                    </div>

                    <div class="bg-white p-6 md:p-8 rounded-[2rem] shadow-sm border border-slate-200">
                        <div class="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
                            <h3 class="text-xl font-black text-slate-800"><i class="fas fa-users text-blue-500 mr-2"></i> Group Backups</h3>
                        </div>
                        <div class="mb-6">
                            <button type="button" onclick="triggerUpload('group')" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3.5 rounded-2xl transition active:scale-[0.98]">
                                <i class="fas fa-upload mr-2"></i> Upload Group Backup
                            </button>
                            <p class="text-[11px] text-slate-400 mt-2 text-center">To create a Group Backup, go to the specific Group's page.</p>
                        </div>
                        <div class="max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                            ${groupHtml}
                        </div>
                    </div>
                </div>
            </div>

            ${getUploadScript()}

        </body>
        </html>
    `);
});

// ==========================================
// 🌟 6. SETTINGS ACTIONS
// ==========================================
adminApp.post('/change-credentials', async (req, res) => {
    try {
        const { username, newPassword } = req.body;
        const setting = await Setting.findOne({});
        
        if (setting) {
            setting.adminUsername = username.trim();
            if (newPassword && newPassword.trim() !== '') {
                setting.adminPasswordHash = hashPassword(newPassword.trim());
            }
            await setting.save();
            res.send(`<script>alert('✅ Admin Login Credentials Updated!'); window.location.href='/admin/settings';</script>`);
        }
    } catch(e) { 
        res.status(500).send("Error updating credentials"); 
    }
});

adminApp.post('/save-telegram-settings', async (req, res) => {
    try {
        const { botToken, adminId, backupIntervalMinutes } = req.body;
        await Setting.findOneAndUpdate({}, { 
            botToken, 
            adminId, 
            backupIntervalMinutes: Number(backupIntervalMinutes) 
        }, { upsert: true });
        
        startTelegramAutoBackup(); 
        res.send(`<script>alert('✅ Telegram Settings Saved! 2FA OTP is now active.'); window.location.href='/admin/settings';</script>`);
    } catch(e) { 
        res.status(500).send("Error saving settings"); 
    }
});

adminApp.post('/backfill-server-labels', async (req, res) => {
    try {
        const users = await User.find({}, { _id: 1, accessKeys: 1, serverLabels: 1 });
        let changedUsers = 0;
        let addedLabels = 0;

        for (const user of users) {
            const keys = user.accessKeys && typeof user.accessKeys === 'object' ? Object.keys(user.accessKeys) : [];
            if (keys.length === 0) continue;

            const labels = (user.serverLabels && typeof user.serverLabels === 'object') ? { ...user.serverLabels } : {};
            let changed = false;

            for (const key of keys) {
                if (!labels[key] || !String(labels[key]).trim()) {
                    labels[key] = key;
                    addedLabels++;
                    changed = true;
                }
            }

            if (changed) {
                await User.updateOne({ _id: user._id }, { $set: { serverLabels: labels } });
                changedUsers++;
            }
        }

        res.send(`<script>alert('✅ Backfill completed. Updated users: ${changedUsers}, labels added: ${addedLabels}'); window.location.href='/admin/settings';</script>`);
    } catch (e) {
        res.send(`<script>alert('❌ Backfill failed: ${e.message}'); window.location.href='/admin/settings';</script>`);
    }
});

adminApp.post('/send-telegram-backup', async (req, res) => {
    try {
        const setting = await Setting.findOne({});
        if (!setting || !setting.botToken || !setting.adminId) {
            return res.send(`<script>alert('❌ Configure Bot Token first!'); window.location.href='/admin/settings';</script>`);
        }
        
        const { filePath, filename } = await generateFullBackupFile();
        await sendBackupDocument(setting.botToken, setting.adminId, filePath, `📦 Manual System Backup\nFile: ${filename}\nTime: ${getMMTString()}`);
        
        res.send(`<script>alert('✅ Backup sent to Telegram!'); window.location.href='/admin/settings';</script>`);
    } catch(e) { 
        res.send(`<script>alert('❌ Failed: ${e.message}'); window.location.href='/admin/settings';</script>`); 
    }
});

adminApp.post('/search', async (req, res) => {
    try {
        const query = req.body.query.trim(); 
        let token = query;
        
        const match = query.match(/\/([A-Za-z0-9]+)\.json/); 
        if (match) token = match[1];
        
        const user = await User.findOne({ token: token });
        if (user) {
            res.redirect('/admin/group/' + encodeURIComponent(user.groupName) + '?highlight=' + token);
        } else {
            res.send(`<script>alert('User not found!'); window.location.href='/admin';</script>`);
        }
    } catch(e) { 
        res.redirect('/admin'); 
    }
});

// ==========================================
// 🌟 7. BACKUP APIs
// ==========================================
adminApp.post('/backup-all', async (req, res) => { 
    try { 
        await generateFullBackupFile(); 
        res.redirect('/admin/settings'); 
    } catch (err) { 
        res.status(500).send("Error"); 
    } 
});

adminApp.post('/backup-group', async (req, res) => {
    try {
        const groupName = req.body.groupName; 
        const group = await Group.findOne({ name: groupName }); 
        const users = await User.find({ groupName: groupName });
        
        const data = { type: 'group', groupName: groupName, date: new Date(), group, users };
        const filename = `Group_${groupName}_${getMMTString()}.json`.replace(/\s+/g, '_');
        
        fs.writeFileSync(path.join(backupDir, filename), JSON.stringify(data, null, 2)); 
        res.redirect('/admin/settings');
    } catch (err) { 
        res.status(500).send("Error"); 
    }
});

adminApp.get('/download-backup/:filename', (req, res) => { 
    const filePath = path.join(backupDir, req.params.filename); 
    if (fs.existsSync(filePath)) {
        res.download(filePath); 
    } else {
        res.status(404).send('Not found'); 
    }
});

adminApp.post('/delete-backup', (req, res) => { 
    try { 
        const filePath = path.join(backupDir, req.body.filename); 
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
        res.redirect('/admin/settings'); 
    } catch(e) { 
        res.redirect('/admin/settings'); 
    } 
});

adminApp.post('/api/restore-upload', async (req, res) => {
    try {
        const { data, expectedGroup } = req.body; 
        if(!data) return res.json({success: false, error: 'No data'});
        
        const cleanObj = (obj) => { const { _id, __v, ...rest } = obj._doc || obj; return rest; };
        
        if (data.type === 'full') {
            if(data.groups) for (let g of data.groups) await Group.updateOne({name: g.name}, {$set: cleanObj(g)}, {upsert: true});
            if(data.masters) for (let m of data.masters) await Master.updateOne({ip: m.ip}, {$set: cleanObj(m)}, {upsert: true});
            if(data.users) for (let u of data.users) await User.updateOne({token: u.token}, {$set: cleanObj(u)}, {upsert: true});
        } else if (data.type === 'group') {
            if (expectedGroup && data.groupName !== expectedGroup) return res.json({success: false, error: `Wrong Group`});
            if(data.group) await Group.updateOne({name: data.group.name}, {$set: cleanObj(data.group)}, {upsert: true});
            if(data.users) for (let u of data.users) await User.updateOne({token: u.token}, {$set: cleanObj(u)}, {upsert: true});
        } else {
            return res.json({success: false, error: 'Invalid Type'});
        }
        res.json({success: true});
    } catch(e) { 
        res.json({success: false, error: e.message}); 
    }
});


// ==========================================
// 🌟 8. MASTER SERVER APIs
// ==========================================
adminApp.post('/api/fetch-master-groups', async (req, res) => {
    try { 
        let { masterIp, masterApiKey } = req.body; 
        masterIp = normalizeMasterBaseUrl(masterIp);
        const apiKeyHeader = masterApiKey || process.env.PANELMASTER_API_KEY;
        
        try {
            const response = await fetchWithRetry(masterIp + '/api/active-groups', null, { 
                method: 'get', headers: { 'x-api-key': apiKeyHeader }, timeout: 5000 
            }, 1, 500);
            if (response.data && response.data.groups) return res.json({ success: true, groups: response.data.groups }); 
        } catch (getErr) {
            const responsePost = await fetchWithRetry(masterIp + '/api/active-groups', {}, { 
                method: 'post', headers: { 'x-api-key': apiKeyHeader }, timeout: 5000 
            }, 1, 500);
            if (responsePost.data && responsePost.data.groups) return res.json({ success: true, groups: responsePost.data.groups }); 
            else throw new Error("Invalid API");
        }
    } catch (error) { 
        res.json({ success: false, error: error.message }); 
    }
});

adminApp.post('/add-master', async (req, res) => { 
    try { 
        let { name, ip, apiKey } = req.body; 
        ip = normalizeMasterBaseUrl(ip);
        if (!ip) return res.status(400).send("Invalid master URL");
        await Master.create({ name, ip, apiKey }); 
        res.redirect('/admin'); 
    } catch (e) { 
        res.status(500).send("Error"); 
    } 
});

adminApp.post('/delete-master', async (req, res) => { 
    await Master.findByIdAndDelete(req.body.id); 
    res.redirect('/admin'); 
});

adminApp.post('/delete-all-masters', async (req, res) => {
    try {
        await Master.deleteMany({});
        res.redirect('/admin');
    } catch (e) { 
        res.redirect('/admin'); 
    }
});

adminApp.post('/create-group', async (req, res) => {
    try {
        const { groupName, masterGroupId, nsRecord, masterIp, masterApiKey, masterName, panelLabel } = req.body;
        const cleanNsRecord = normalizeHost(nsRecord);
        if (groupName && masterGroupId && cleanNsRecord && masterIp && masterApiKey) { 
            if (!NS_RECORD_HOST_RE.test(cleanNsRecord)) {
                return res.status(400).send("Invalid custom DNS hostname");
            }
            let cleanIp = normalizeMasterBaseUrl(masterIp);
            await Group.create({
                name: groupName,
                masterGroupId,
                nsRecord: cleanNsRecord,
                masterIp: cleanIp,
                masterApiKey,
                masterName: masterName || "1",
                panelLabel: (panelLabel || 'Premium').toString().trim() || 'Premium'
            });
        }
        res.redirect('/admin');
    } catch (error) { 
        res.status(500).send("Error creating group"); 
    }
});

adminApp.post('/update-group-panel-label', async (req, res) => {
    try {
        const groupName = (req.body.groupName || '').toString();
        const panelLabel = (req.body.panelLabel || '').toString().trim();
        await Group.updateOne({ name: groupName }, { panelLabel: panelLabel || 'Premium' });
        res.redirect('/admin/group/' + encodeURIComponent(groupName));
    } catch (e) {
        res.status(500).send("Error updating panel label");
    }
});

const NS_RECORD_HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

adminApp.post('/update-group-ns-record', async (req, res) => {
    try {
        const groupName = (req.body.groupName || '').toString();
        const raw = normalizeHost(req.body.nsRecord);
        if (!raw || !NS_RECORD_HOST_RE.test(raw)) {
            return res.status(400).send('Invalid custom DNS hostname (use e.g. ns1.example.com, no path or spaces).');
        }
        const updated = await Group.updateOne({ name: groupName }, { nsRecord: raw });
        if (updated.matchedCount === 0) {
            return res.status(404).send('Group not found');
        }
        res.redirect('/admin/group/' + encodeURIComponent(groupName));
    } catch (e) {
        res.status(500).send('Error updating custom DNS');
    }
});

adminApp.post('/delete-group', async (req, res) => {
    try {
        const groupInfo = await Group.findOne({ name: req.body.groupName }); 
        const users = await User.find({ groupName: req.body.groupName });
        
        if (groupInfo) { 
            const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;
            for (const u of users) { 
                try { 
                    await fetchWithRetry(groupInfo.masterIp + '/api/internal/delete-user', { username: u.name, token: u.token }, { headers: { 'x-api-key': apiKeyHeader } }); 
                } catch(e) {} 
            } 
        }
        
        await Group.deleteOne({ name: req.body.groupName }); 
        await User.deleteMany({ groupName: req.body.groupName }); 
        res.redirect('/admin');
    } catch (error) { 
        res.status(500).send("Error deleting group"); 
    }
});

adminApp.post('/update-group-master', async (req, res) => {
    try {
        const { groupName, masterData } = req.body;
        if(masterData) { 
            const [ip, apiKey, name] = masterData.split('|'); 
            await Group.updateOne({ name: groupName }, { masterIp: ip, masterApiKey: apiKey, masterName: name }); 
        }
        res.redirect('/admin/group/' + encodeURIComponent(groupName));
    } catch (e) { 
        res.status(500).send("Error updating connection"); 
    }
});

// ==========================================
// 🌟 9. INSIDE GROUP VIEW
// ==========================================
adminApp.get('/group/:name', async (req, res) => {
    const groupName = req.params.name;
    const highlightToken = req.query.highlight; 
    
    const groupInfo = await Group.findOne({ name: groupName });
    const users = await User.find({ groupName: groupName }).sort({ userNo: 1 }); 
    const masters = await Master.find({}); 
    
    const normalizedGroupHost = normalizeHost(groupInfo && groupInfo.nsRecord);
    const domainName = normalizedGroupHost || '';
    const panelHost = normalizedGroupHost || '';
    const groupPanelLabel = (groupInfo && groupInfo.panelLabel ? groupInfo.panelLabel : 'Premium').toString();
    const safeGroupPanelLabel = groupPanelLabel.replace(/"/g, '&quot;');
    const safeNsRecord = (normalizedGroupHost || ((groupInfo && groupInfo.nsRecord) ? groupInfo.nsRecord : '')).replace(/"/g, '&quot;');
    const webhookVersionText = String((groupInfo && groupInfo.lastWebhookVersion) ? groupInfo.lastWebhookVersion : '').trim();
    const webhookServerIdText = String((groupInfo && groupInfo.lastWebhookServerId) ? groupInfo.lastWebhookServerId : '').trim();
    const webhookEventAtText = String((groupInfo && groupInfo.lastWebhookEventAt) ? groupInfo.lastWebhookEventAt : '').trim();
    const webhookReceivedAtText = (groupInfo && groupInfo.lastWebhookReceivedAt)
        ? new Date(groupInfo.lastWebhookReceivedAt).toISOString()
        : '';
    let activeNodeItems = [];
    let activeNodeIdSet = new Set();
    let activeNodeLabelById = {};
    let activeNodeCountText = 'Unknown';
    let activeNodeError = '';
    let activeNodeSourceNote = '';
    const buildFallbackActiveNodes = () => {
        const fallbackItems = [];
        const seenFallback = new Set();
        for (const u of users) {
            const keys = (u.accessKeys && typeof u.accessKeys === 'object') ? Object.keys(u.accessKeys) : [];
            for (const key of keys) {
                const id = String(key || '').trim();
                if (!id || seenFallback.has(id)) continue;
                seenFallback.add(id);
                const label = (u.serverLabels && u.serverLabels[id]) ? String(u.serverLabels[id]) : id;
                fallbackItems.push({ id, label });
            }
        }
        return fallbackItems;
    };

    if (groupInfo && groupInfo.masterIp) {
        try {
            const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;
            let response;
            try {
                response = await fetchWithRetry(groupInfo.masterIp + '/api/active-groups', null, {
                    method: 'get',
                    headers: { 'x-api-key': apiKeyHeader },
                    timeout: 2800
                }, 1, 200);
            } catch (e) {
                response = await fetchWithRetry(groupInfo.masterIp + '/api/active-groups', {}, {
                    method: 'post',
                    headers: { 'x-api-key': apiKeyHeader },
                    timeout: 2800
                }, 1, 200);
            }

            const groups = (response && response.data && Array.isArray(response.data.groups)) ? response.data.groups : [];
            const targetGroup = groups.find((g) => String(g.id) === String(groupInfo.masterGroupId)) ||
                groups.find((g) => String(g.name) === String(groupInfo.name));
            let nodesFromMasterApiList = false;
            const normalizeNode = (n, fallbackId = '') => {
                if (typeof n === 'string') return { id: n, label: n };
                if (n !== null && typeof n !== 'object') {
                    const fb = String(fallbackId || '').trim();
                    return fb ? { id: fb, label: fb } : null;
                }
                if (!n || typeof n !== 'object') return null;
                const id = n.id || n.serverId || n.nodeId || n.key || fallbackId || n.name || n.serverName || n.nodeName || '';
                const label = n.displayName || n.name || n.serverName || n.nodeName || n.title || id || '';
                if (!id && !label) return null;
                return { id: String(id || label), label: String(label || id) };
            };

            if (targetGroup) {
                const rawNodes =
                    targetGroup.activeNodes ??
                    targetGroup.nodes ??
                    targetGroup.servers ??
                    targetGroup.serverList ??
                    targetGroup.activeNodeList ??
                    targetGroup.onlineNodes ??
                    targetGroup.nodeList;

                if (Array.isArray(rawNodes)) {
                    activeNodeItems = rawNodes.map((n) => normalizeNode(n)).filter(Boolean);
                } else if (rawNodes && typeof rawNodes === 'object') {
                    activeNodeItems = Object.entries(rawNodes)
                        .map(([k, v]) => normalizeNode(v, k))
                        .filter(Boolean);
                } else if (typeof rawNodes === 'string' && rawNodes.trim()) {
                    activeNodeItems = rawNodes.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ id: s, label: s }));
                }
                if (activeNodeItems.length > 0) {
                    nodesFromMasterApiList = true;
                }
            }

            // Fast fallback: union of all users' accessKeys (no extra master HTTP on page load).
            if (activeNodeItems.length === 0) {
                activeNodeItems = buildFallbackActiveNodes();
            }

            // De-duplicate node list by ID.
            const seenNodeIds = new Set();
            activeNodeItems = activeNodeItems.filter((n) => {
                const id = String(n && n.id ? n.id : '').trim();
                if (!id || seenNodeIds.has(id)) return false;
                seenNodeIds.add(id);
                return true;
            });

            // Ping-filter ONLY when master returned an explicit node list (not DB union).
            // Short timeouts + restore list if ping wipes everything (slow master / flaky ping).
            if (nodesFromMasterApiList && activeNodeItems.length > 0) {
                const beforePing = activeNodeItems.slice();
                const pingActiveSet = new Set();
                const pingCheckedSet = new Set();
                let pingCheckedCount = 0;
                await Promise.all(beforePing.slice(0, 20).map(async (node) => {
                    try {
                        const pingRes = await axios.get(`${groupInfo.masterIp}/api/ping/${encodeURIComponent(node.id)}`, {
                            headers: { 'x-api-key': apiKeyHeader },
                            timeout: 700
                        });
                        pingCheckedSet.add(String(node.id));
                        pingCheckedCount += 1;
                        const pingData = pingRes && pingRes.data ? pingRes.data : {};
                        const isOnline = pingData.status === 'online' || pingData.online === true || Number.isFinite(Number(pingData.latency_ms));
                        if (isOnline) pingActiveSet.add(String(node.id));
                    } catch (e) {}
                }));
                if (pingCheckedCount > 0) {
                    // Do not hide nodes that were not checked by ping.
                    const filtered = beforePing.filter((n) => {
                        const id = String(n && n.id ? n.id : '');
                        return !pingCheckedSet.has(id) || pingActiveSet.has(id);
                    });
                    activeNodeItems = filtered.length > 0 ? filtered : beforePing;
                }
            }

            activeNodeLabelById = activeNodeItems.reduce((acc, n) => {
                if (n && n.id) acc[String(n.id)] = String(n.label || n.id);
                return acc;
            }, {});
            activeNodeIdSet = new Set(activeNodeItems.map((n) => String(n.id)));
            activeNodeCountText = String(activeNodeItems.length);
            if (nodesFromMasterApiList && activeNodeItems.length > 0) {
                activeNodeSourceNote = 'Master API node list (online filter when possible).';
            } else if (activeNodeItems.length > 0) {
                activeNodeSourceNote = "Union of users' keys in this group (fast). Use Sync Nodes so new master nodes reach all users.";
            }
        } catch (err) {
            activeNodeItems = buildFallbackActiveNodes();
            activeNodeLabelById = activeNodeItems.reduce((acc, n) => {
                if (n && n.id) acc[String(n.id)] = String(n.label || n.id);
                return acc;
            }, {});
            activeNodeIdSet = new Set(activeNodeItems.map((n) => String(n.id)));
            activeNodeCountText = String(activeNodeItems.length);
            if (activeNodeItems.length > 0) {
                activeNodeSourceNote = "Master API unavailable; showing users' keys in this group.";
                activeNodeError = '';
            } else {
                activeNodeError = 'Cannot load nodes from master API right now.';
            }
        }
    }

    let usersHtml = '';
    users.forEach((u) => {
        const ssconfLink = domainName
            ? `ssconf://${domainName}/${u.token}.json#QitoVPN_${encodeURIComponent(u.name.replace(/\s+/g, ''))}`
            : '';
        const webPanelLink = panelHost ? `https://${panelHost}/panel/${u.token}` : '';
        const userNodeKeys = (u.accessKeys && typeof u.accessKeys === 'object') ? Object.keys(u.accessKeys) : [];
        const serverCount = userNodeKeys.filter((k) => activeNodeIdSet.has(String(k))).length;
        const currentServerId = u.currentServer || 'None';
        const currentServerLabel = (u.serverLabels && u.currentServer && u.serverLabels[u.currentServer])
            ? u.serverLabels[u.currentServer]
            : (activeNodeLabelById[currentServerId] || currentServerId);
        const usagePercent = u.totalGB > 0 ? ((u.usedGB / u.totalGB) * 100).toFixed(1) : 0;
        
        const isHighlighted = (u.token === highlightToken) ? 'bg-yellow-100 border-l-4 border-yellow-500 animate-pulse transition-colors shadow-inner' : 'hover:bg-indigo-50/50';

        usersHtml += `
        <tr id="user-${u.token}" class="border-b border-slate-100 ${isHighlighted} transition duration-500">
            <td class="p-4 text-slate-800 font-black">#${u.userNo || '-'}</td>
            <td class="p-4">
                <div class="font-bold ${u.isBlocked ? 'text-red-500 line-through' : 'text-slate-800'}">${u.name}${u.isBlocked ? ' <span class="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-black uppercase no-underline inline-block ml-1">Blocked</span>' : ''}</div>
                <div class="text-xs text-indigo-500 font-mono bg-indigo-50 px-2 py-0.5 rounded inline-block mt-1 border border-indigo-100 shadow-sm">${u.token}</div>
            </td>
            <td class="p-4">
                <span class="bg-slate-200 px-2 py-1 rounded text-[11px] font-black uppercase text-slate-600 mr-2">${serverCount} Nodes</span>
                <div class="inline-flex flex-col align-middle">
                    <span class="text-sm font-bold text-slate-700">${currentServerLabel}</span>
                    ${currentServerLabel !== currentServerId ? `<span class="text-[11px] font-semibold text-slate-500">ID: ${currentServerId}</span>` : ''}
                </div>
            </td>
            <td class="p-4 text-sm font-bold text-slate-600">${u.expireDate}</td>
            <td class="p-4 w-48">
                <div class="flex justify-between text-[11px] mb-1 font-bold uppercase tracking-wider">
                    <span class="text-indigo-600">${u.usedGB} GB</span>
                    <span class="text-slate-400">${u.totalGB} GB</span>
                </div>
                <div class="w-full bg-slate-200 rounded-full h-2 shadow-inner">
                    <div class="bg-indigo-500 h-2 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.5)]" style="width: ${usagePercent}%"></div>
                </div>
            </td>
            <td class="p-4 text-right flex justify-end gap-2">
                <button id="panelBtn-${u.token}" onclick="copyLink('${webPanelLink}', 'panelBtn-${u.token}', '<i class=\\'fas fa-globe\\'></i>')" class="bg-blue-50 text-blue-600 hover:bg-blue-500 hover:text-white px-3 py-2 rounded-lg text-sm font-bold transition shadow-sm" title="Copy Web Panel Link">
                    <i class="fas fa-globe"></i>
                </button>
                <button id="btn-${u.token}" onclick="copyLink('${ssconfLink}', 'btn-${u.token}', '<i class=\\'fas fa-link\\'></i>')" class="bg-teal-50 text-teal-600 hover:bg-teal-500 hover:text-white px-3 py-2 rounded-lg text-sm font-bold transition shadow-sm" title="Copy SSCONF Link">
                    <i class="fas fa-link"></i>
                </button>
                <button onclick="openEditModal('${u.token}', '${u.totalGB}', '${u.expireDate}')" class="bg-yellow-50 text-yellow-600 hover:bg-yellow-500 hover:text-white px-3 py-2 rounded-lg text-sm font-bold transition shadow-sm" title="Edit User">
                    <i class="fas fa-edit"></i>
                </button>
                <form action="/admin/toggle-block-user" method="POST" class="m-0" onsubmit="return confirm('${u.isBlocked ? 'ပြန်ဖွင့်မှာ သေချာပြီလား?' : 'ပိတ်မှာ သေချာပြီလား?'}');">
                    <input type="hidden" name="token" value="${u.token}">
                    <input type="hidden" name="groupName" value="${u.groupName}">
                    <button type="submit" class="${u.isBlocked ? 'bg-green-50 text-green-600 hover:bg-green-500' : 'bg-orange-50 text-orange-500 hover:bg-orange-500'} hover:text-white px-3 py-2 rounded-lg text-sm font-bold transition shadow-sm" title="${u.isBlocked ? 'Unblock User' : 'Block User'}">
                        <i class="fas ${u.isBlocked ? 'fa-unlock' : 'fa-lock'}"></i>
                    </button>
                </form>
                <form action="/admin/delete-user" method="POST" onsubmit="return confirm('ဖျက်မှာ သေချာပြီလား?');" class="m-0">
                    <input type="hidden" name="token" value="${u.token}">
                    <input type="hidden" name="groupName" value="${u.groupName}">
                    <button type="submit" class="bg-red-50 text-red-500 hover:bg-red-600 hover:text-white px-3 py-2 rounded-lg text-sm font-bold transition shadow-sm" title="Delete User">
                        <i class="fas fa-trash"></i>
                    </button>
                </form>
            </td>
        </tr>`;
    });

    let relinkOptions = '<option value="" disabled selected>Select Master API to Re-link...</option>';
    masters.forEach(m => { relinkOptions += `<option value="${m.ip}|${m.apiKey}|${m.name}">${m.name} (${m.ip})</option>`; });

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Group Management</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
            <style>
                @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
            </style>
        </head>
        <body class="bg-[#f8fafc] font-sans pb-10">
            
            ${getNavbar()}
            ${getLoadingModal()}

            <nav class="bg-white border-b border-slate-200 shadow-sm p-4 mb-8 -mt-8 sticky top-[88px] z-30 animate-fade-in-up">
                <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
                    <div class="flex items-center">
                        <a href="/admin" class="text-slate-400 hover:text-indigo-600 mr-4 text-xl transition transform hover:-translate-x-1">
                            <i class="fas fa-arrow-left"></i>
                        </a>
                        <span class="font-black text-2xl text-slate-800">${groupName}</span>
                        <span class="ml-3 text-[10px] font-black text-white bg-indigo-500 px-2 py-1 rounded shadow-sm uppercase tracking-widest">${groupInfo.masterName || 'API'}</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-3">
                        <div class="hidden md:block text-xs font-bold text-slate-500 bg-slate-100 px-3 py-2 rounded-xl border border-slate-200">
                            <i class="fas fa-link text-indigo-400 mr-1"></i> ${groupInfo.masterIp || 'Not Linked'}
                        </div>
                        <button type="button" onclick="triggerUpload('group', '${groupName}')" class="bg-slate-800 text-white hover:bg-black px-4 py-2 rounded-xl text-sm font-bold transition shadow-sm flex items-center">
                            <i class="fas fa-upload mr-2"></i> Upload Backup
                        </button>
                        <form action="/admin/backup-group" method="POST" class="m-0">
                            <input type="hidden" name="groupName" value="${groupName}">
                            <button type="submit" class="bg-blue-100 text-blue-700 hover:bg-blue-600 hover:text-white px-4 py-2 rounded-xl text-sm font-bold transition shadow-sm border border-blue-200 flex items-center">
                                <i class="fas fa-download mr-2"></i> Download Backup
                            </button>
                        </form>
                        <form action="/admin/sync-group-nodes" method="POST" class="m-0" onsubmit="this.querySelector('button').textContent='Syncing...';">
                            <input type="hidden" name="groupName" value="${groupName}">
                            <button type="submit" class="bg-indigo-600 text-white hover:bg-indigo-700 px-4 py-2 rounded-xl text-sm font-bold transition shadow-[0_4px_14px_rgba(79,70,229,0.3)] active:scale-95 flex items-center">
                                <i class="fas fa-sync-alt mr-2"></i> Sync Nodes
                            </button>
                        </form>
                    </div>
                </div>
            </nav>

            <div class="max-w-7xl mx-auto px-4 animate-fade-in-up">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                    <div class="md:col-span-2 bg-white rounded-[2rem] shadow-sm border border-slate-200 p-8">
                        <label class="block text-lg font-black text-slate-800 mb-5"><i class="fas fa-user-plus text-green-500 mr-2 drop-shadow"></i> Generate New Key</label>
                        <form action="/admin/add-user" method="POST" class="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <input type="hidden" name="groupName" value="${groupName}">
                            <input type="text" name="name" placeholder="User Name" required class="border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-800 transition">
                            <input type="number" name="totalGB" placeholder="Data (GB)" required class="border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-800 transition">
                            <input type="date" name="expireDate" required class="border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-600 transition">
                            <button type="submit" class="bg-indigo-600 text-white rounded-2xl py-3.5 font-bold hover:bg-indigo-700 transition text-sm shadow-[0_4px_15px_rgba(79,70,229,0.3)] active:scale-[0.98]">Add User</button>
                        </form>
                    </div>
                    <div class="bg-gradient-to-br from-yellow-50 to-orange-50 rounded-[2rem] shadow-sm border border-yellow-200 p-8">
                        <label class="block text-lg font-black text-yellow-800 mb-4"><i class="fas fa-plug text-yellow-600 mr-2 drop-shadow"></i> Update Connection</label>
                        <form action="/admin/update-group-master" method="POST" class="flex flex-col gap-3">
                            <input type="hidden" name="groupName" value="${groupName}">
                            <select name="masterData" required class="w-full border-2 border-yellow-300 bg-white p-3 rounded-2xl outline-none focus:border-yellow-500 font-bold text-sm text-slate-700 transition">${relinkOptions}</select>
                            <button type="submit" class="w-full bg-yellow-500 text-white rounded-2xl py-3.5 font-bold hover:bg-yellow-600 transition text-sm shadow-md active:scale-[0.98]">Re-Link Master</button>
                        </form>
                        <form action="/admin/update-group-panel-label" method="POST" class="flex flex-col gap-3 mt-4 pt-4 border-t border-yellow-200">
                            <input type="hidden" name="groupName" value="${groupName}">
                            <input type="text" name="panelLabel" value="${safeGroupPanelLabel}" class="w-full border-2 border-yellow-300 bg-white p-3 rounded-2xl outline-none focus:border-yellow-500 font-bold text-sm text-slate-700 transition" placeholder="Panel badge text">
                            <button type="submit" class="w-full bg-slate-800 text-white rounded-2xl py-3.5 font-bold hover:bg-black transition text-sm shadow-md active:scale-[0.98]">Save Panel Badge</button>
                        </form>
                        <form action="/admin/update-group-ns-record" method="POST" class="flex flex-col gap-3 mt-4 pt-4 border-t border-yellow-200">
                            <label class="text-[11px] font-black text-yellow-800 uppercase tracking-widest">Custom DNS (ssconf + panel links)</label>
                            <input type="hidden" name="groupName" value="${groupName}">
                            <input type="text" name="nsRecord" value="${safeNsRecord}" required class="w-full border-2 border-indigo-300 bg-white p-3 rounded-2xl outline-none focus:border-indigo-500 font-mono text-sm text-slate-700 transition" placeholder="e.g. ns1.yourdomain.com">
                            <button type="submit" class="w-full bg-indigo-600 text-white rounded-2xl py-3.5 font-bold hover:bg-indigo-700 transition text-sm shadow-md active:scale-[0.98]">Save Custom DNS</button>
                        </form>
                    </div>
                </div>

                <div class="bg-white rounded-[2rem] shadow-sm border border-slate-200 p-6 mb-8">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-black text-slate-800"><i class="fas fa-network-wired text-indigo-500 mr-2"></i> Active Nodes from Master</h3>
                        <span class="text-xs font-black bg-indigo-100 text-indigo-700 px-3 py-1 rounded-xl border border-indigo-200">Count: ${activeNodeCountText}</span>
                    </div>
                    ${(webhookVersionText || webhookReceivedAtText || webhookServerIdText)
                        ? `<div class="mb-2 text-[11px] font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                            <span class="mr-3">Webhook Version: <span class="font-black text-slate-800">${webhookVersionText || '-'}</span></span>
                            <span class="mr-3">Last Server ID: <span class="font-black text-slate-800">${webhookServerIdText || '-'}</span></span>
                            <span class="mr-3">Event At: <span class="font-black text-slate-800">${webhookEventAtText || '-'}</span></span>
                            <span>Received At: <span class="font-black text-slate-800">${webhookReceivedAtText || '-'}</span></span>
                        </div>`
                        : `<div class="mb-2 text-[11px] font-semibold text-slate-500">Webhook Version: -</div>`
                    }
                    ${activeNodeSourceNote ? `<p class="text-[11px] text-slate-500 font-semibold mb-2">${activeNodeSourceNote}</p>` : ''}
                    ${activeNodeError ? `<p class="text-sm text-red-500 font-bold">${activeNodeError}</p>` : ''}
                    ${activeNodeItems.length > 0
                        ? `<div class="flex flex-wrap gap-2">${activeNodeItems.map((n) => `<span class="text-xs font-bold bg-slate-100 text-slate-700 px-3 py-1 rounded-xl border border-slate-200">${n.label}${n.label !== n.id ? ` <span class='text-slate-500 font-semibold'>(ID: ${n.id})</span>` : ''}</span>`).join('')}</div>`
                        : `<p class="text-sm text-slate-500">No active node list returned for this group.</p>`
                    }
                </div>

                <div class="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left min-w-[800px]">
                            <thead>
                                <tr class="bg-slate-50 border-b border-slate-200 text-xs uppercase tracking-widest text-slate-400 font-black">
                                    <th class="p-5">ID</th><th class="p-5">User Info</th><th class="p-5">Current Node</th><th class="p-5">Expire Date</th><th class="p-5">Data Usage</th><th class="p-5 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${usersHtml}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div id="editModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/60 backdrop-blur-sm transition-opacity opacity-0 duration-300">
                <div class="bg-white rounded-[2rem] p-8 w-full max-w-md shadow-2xl border border-slate-100 transform scale-95 transition-transform duration-300" id="editModalContent">
                    <div class="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
                        <h3 class="text-xl font-black text-slate-800"><i class="fas fa-user-edit text-indigo-500 mr-2"></i> Edit User</h3>
                        <button onclick="closeEditModal()" class="text-slate-400 hover:text-red-500 transition bg-slate-100 w-8 h-8 rounded-full flex items-center justify-center"><i class="fas fa-times"></i></button>
                    </div>
                    <form action="/admin/edit-user" method="POST" class="flex flex-col gap-5">
                        <input type="hidden" name="groupName" value="${groupName}">
                        <input type="hidden" name="oldToken" id="editOldToken">
                        <div>
                            <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Token (Link ID)</label>
                            <input type="text" name="newToken" id="editNewToken" required class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-mono text-sm text-slate-700 bg-slate-50">
                        </div>
                        <div class="flex gap-4">
                            <div class="flex-1">
                                <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Total GB</label>
                                <input type="number" name="newTotalGB" id="editTotalGB" required class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-700">
                            </div>
                            <div class="flex-1">
                                <label class="block text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">Expire Date</label>
                                <input type="date" name="newExpireDate" id="editExpireDate" required class="w-full border-2 border-slate-200 p-3.5 rounded-2xl outline-none focus:border-indigo-500 font-bold text-sm text-slate-700">
                            </div>
                        </div>
                        <div class="flex gap-3 mt-4 pt-4 border-t border-slate-100">
                            <button type="button" onclick="closeEditModal()" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold py-3.5 rounded-2xl transition active:scale-[0.98]">Cancel</button>
                            <button type="submit" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(79,70,229,0.3)] active:scale-[0.98]">Save Changes</button>
                        </div>
                    </form>
                </div>
            </div>

            ${getUploadScript()}

            <script>
                window.onload = () => {
                    const urlParams = new URLSearchParams(window.location.search);
                    const highlight = urlParams.get('highlight');
                    if (highlight) {
                        const el = document.getElementById('user-' + highlight);
                        if (el) setTimeout(() => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 500);
                    }
                };

                function openEditModal(token, gb, expire) {
                    document.getElementById('editOldToken').value = token; 
                    document.getElementById('editNewToken').value = token;
                    document.getElementById('editTotalGB').value = gb; 
                    document.getElementById('editExpireDate').value = expire;
                    
                    const modal = document.getElementById('editModal'); 
                    const content = document.getElementById('editModalContent');
                    modal.classList.remove('hidden'); 
                    modal.classList.add('flex');
                    setTimeout(() => { modal.classList.remove('opacity-0'); content.classList.remove('scale-95'); }, 10);
                }

                function closeEditModal() {
                    const modal = document.getElementById('editModal'); 
                    const content = document.getElementById('editModalContent');
                    modal.classList.add('opacity-0'); 
                    content.classList.add('scale-95');
                    setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 300);
                }

                function copyLink(link, btnId, origHtml) {
                    var tempInput = document.createElement("input"); 
                    tempInput.value = link; 
                    document.body.appendChild(tempInput); 
                    tempInput.select(); 
                    document.execCommand("copy"); 
                    document.body.removeChild(tempInput);
                    
                    var btn = document.getElementById(btnId); 
                    btn.innerHTML = '<i class="fas fa-check"></i>'; 
                    btn.classList.add('bg-green-500', 'text-white');
                    setTimeout(() => { btn.innerHTML = origHtml; btn.classList.remove('bg-green-500', 'text-white'); }, 2000);
                }
            </script>
        </body>
        </html>
    `);
});

// ==========================================
// 🌟 10. USER MANAGEMENT ACTIONS
// ==========================================
adminApp.post('/edit-user', async (req, res) => {
    try {
        const { groupName, oldToken, newToken, newTotalGB, newExpireDate } = req.body;
        
        if (oldToken !== newToken) {
            const existingToken = await User.findOne({ token: newToken });
            if (existingToken) return res.status(400).send("Error: This Token already exists in the system.");
        }

        const user = await User.findOne({ token: oldToken });
        if (user) {
            user.token = newToken.trim(); 
            user.totalGB = Number(newTotalGB);
            user.expireDate = newExpireDate;
            await user.save();
            try { await redisClient.del(oldToken); } catch(e){}

            try {
                const groupInfo = await Group.findOne({ name: groupName });
                if (groupInfo && groupInfo.masterIp) {
                    const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;
                    await fetchWithRetry(groupInfo.masterIp + '/api/internal/edit-user', {
                        username: user.name, 
                        totalGB: user.totalGB, 
                        usedGB: user.usedGB, 
                        expireDate: user.expireDate
                    }, { headers: { 'x-api-key': apiKeyHeader } });
                }
            } catch (masterErr) { console.log("⚠️ Master Server update missed."); }
        }
        res.redirect('/admin/group/' + encodeURIComponent(groupName));
    } catch (error) { 
        res.status(500).send("Error updating user details"); 
    }
});

adminApp.post('/sync-group-nodes', async (req, res) => {
    try {
        const groupName = req.body.groupName;
        const groupInfo = await Group.findOne({ name: groupName });
        if (!groupInfo || !groupInfo.masterIp) return res.redirect('/admin');
        await syncGroupUsersFromMaster(groupInfo, { throttleMs: 2000 });
        res.redirect('/admin/group/' + encodeURIComponent(groupName));
    } catch (error) { 
        res.status(500).send("Error syncing nodes"); 
    }
});

// Master webhook: notify node changes and trigger sync for target group(s).
adminApp.post('/master-node-changed', requireApiKey, async (req, res) => {
    try {
        const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
        const groupName = String(body.groupName || body.name || '').trim();
        const masterGroupId = String(body.masterGroupId || body.groupId || body.id || '').trim();

        let groups = [];
        if (groupName) {
            const g = await Group.findOne({ name: groupName });
            if (g) groups.push(g);
        }
        if (groups.length === 0 && masterGroupId) {
            const g = await Group.findOne({ masterGroupId: masterGroupId });
            if (g) groups.push(g);
        }
        if (groups.length === 0 && !groupName && !masterGroupId) {
            groups = await Group.find({ masterIp: { $exists: true, $ne: '' }, masterGroupId: { $exists: true, $ne: '' } });
        }
        if (groups.length === 0) {
            return res.status(404).json({ success: false, error: 'No matching group found for webhook payload.' });
        }

        const summary = [];
        for (const groupInfo of groups) {
            try {
                const result = await syncGroupUsersFromMaster(groupInfo, { throttleMs: 2000 });
                summary.push({ groupName: groupInfo.name, ...result, success: true });
            } catch (e) {
                summary.push({ groupName: groupInfo.name, success: false, error: getErrMsg(e) });
            }
        }

        const allOk = summary.every((s) => s.success);
        return res.status(allOk ? 200 : 207).json({
            success: allOk,
            message: 'Master node change webhook processed.',
            results: summary
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: getErrMsg(err) });
    }
});

adminApp.post('/add-user', async (req, res) => {
    try {
        const { groupName, name, totalGB, expireDate } = req.body;
        const groupInfo = await Group.findOne({ name: groupName });
        if(!groupInfo || !groupInfo.masterIp) return res.status(400).send("Invalid Group Setup");

        const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY; 
        const lastUser = await User.findOne({ groupName: groupName }).sort({ userNo: -1 });
        const nextNo = (lastUser && lastUser.userNo) ? lastUser.userNo + 1 : 1;

        const masterResponse = await fetchWithRetry(groupInfo.masterIp + '/api/generate-keys', {
            masterGroupId: groupInfo.masterGroupId, userName: name, totalGB, expireDate
        }, { headers: { 'x-api-key': apiKeyHeader } });

        if (masterResponse.data && masterResponse.data.keys) {
            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
            const allChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let token = letters.charAt(Math.floor(Math.random() * letters.length));
            for (let i = 0; i < 31; i++) { token += allChars.charAt(Math.floor(Math.random() * allChars.length)); }
            
            const defaultServer = Object.keys(masterResponse.data.keys)[0] || "None";
            await User.create({ 
                name, token, groupName, totalGB: Number(totalGB), usedGB: 0, 
                currentServer: defaultServer,
                expireDate,
                accessKeys: masterResponse.data.keys,
                serverLabels: buildServerLabels(masterResponse.data.keys, {}),
                userNo: nextNo 
            });
            res.redirect('/admin/group/' + encodeURIComponent(groupName));
        } else { 
            res.status(400).send("Master Panel API Error"); 
        }
    } catch (error) { 
        res.status(500).send("Error connecting to Master"); 
    }
});

adminApp.post('/delete-user', async (req, res) => {
    try {
        const token = req.body.token;
        const groupInfo = await Group.findOne({ name: req.body.groupName });
        const user = await User.findOne({ token: token });
        if (groupInfo && user) {
            const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY; 
            try { 
                await fetchWithRetry(groupInfo.masterIp + '/api/internal/delete-user', { username: user.name, token: token }, { headers: { 'x-api-key': apiKeyHeader } }); 
            } catch(e) {}
        }
        await User.deleteOne({ token: token });
        res.redirect('/admin/group/' + encodeURIComponent(req.body.groupName));
    } catch (error) { 
        res.status(500).send("Error deleting user"); 
    }
});

adminApp.post('/toggle-block-user', async (req, res) => {
    try {
        const { token, groupName } = req.body;
        const user = await User.findOne({ token });
        if (!user) return res.status(404).send('User not found');

        const newBlocked = !user.isBlocked;
        await User.updateOne({ _id: user._id }, { $set: { isBlocked: newBlocked } });
        try { await redisClient.del(token); } catch (e) {}

        const groupInfo = await Group.findOne({ name: groupName });
        if (groupInfo && groupInfo.masterIp) {
            const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;
            const action = newBlocked ? 'suspend' : 'resume';
            try {
                await fetchWithRetry(groupInfo.masterIp + '/api/user-action', {
                    token: token,
                    action: action
                }, { headers: { 'x-api-key': apiKeyHeader }, timeout: 10000 });
            } catch (e) {
                console.log(`[toggle-block] master user-action ${action} failed for ${user.name}: ${getErrMsg(e)}`);
            }
        }

        res.redirect('/admin/group/' + encodeURIComponent(groupName));
    } catch (error) {
        res.status(500).send('Error toggling user block status');
    }
});

module.exports = adminApp;
