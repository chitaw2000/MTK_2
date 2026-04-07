require('dotenv').config(); // 🌟 Load .env variables
const express = require('express');
const axios = require('axios');
const userApp = express.Router();
const redisClient = require('../config/redis');
const User = require('../models/User');
const Group = require('../models/Group');
const { requireApiKey } = require('../security/apiKey');

// Automatically inject CSRF token into user panel HTML forms.
userApp.use((req, res, next) => {
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

// 🌟🌟 FIXED: Auto Content-Type & 401 Loop Stop 🌟🌟
async function fetchWithRetry(url, data, config, retries = 3, delay = 1000) {
    const method = (config && config.method) ? config.method.toLowerCase() : 'post';
    
    if (!config) config = {};
    if (!config.headers) config.headers = {};
    config.headers['Content-Type'] = 'application/json'; // 🌟 MUST REQUIREMENT

    for (let i = 0; i < retries; i++) {
        try {
            if (method === 'get') return await axios.get(url, config);
            else return await axios.post(url, data || {}, config); 
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

const Setting = require('../models/Setting');
let _cachedGlobalApiKey = null;
let _cachedGlobalApiKeyAt = 0;
async function resolveApiKeyAsync(groupInfo) {
    if (groupInfo && groupInfo.masterApiKey) return groupInfo.masterApiKey;
    if (_cachedGlobalApiKey && Date.now() - _cachedGlobalApiKeyAt < 60000) return _cachedGlobalApiKey;
    try {
        const s = await Setting.findOne({}, { globalMasterApiKey: 1 });
        const key = (s && s.globalMasterApiKey) ? s.globalMasterApiKey : (process.env.PANELMASTER_API_KEY || '');
        _cachedGlobalApiKey = key;
        _cachedGlobalApiKeyAt = Date.now();
        return key;
    } catch (e) {
        return process.env.PANELMASTER_API_KEY || '';
    }
}
function resolveApiKey(groupInfo) {
    if (groupInfo && groupInfo.masterApiKey) return groupInfo.masterApiKey;
    return _cachedGlobalApiKey || process.env.PANELMASTER_API_KEY || '';
}

async function getActiveNodeProbe(groupInfo, nodeKeys = []) {
    const result = { activeKeys: new Set(), checkedKeys: new Set(), checkedCount: 0 };
    if (!groupInfo || !groupInfo.masterIp || !Array.isArray(nodeKeys) || nodeKeys.length === 0) return result;
    const apiKeyHeader = resolveApiKey(groupInfo);
    const candidates = nodeKeys.slice(0, 20); // keep panel render snappy on huge groups

    await Promise.all(candidates.map(async (nodeKey) => {
        try {
            const response = await axios.get(`${groupInfo.masterIp}/api/ping/${encodeURIComponent(nodeKey)}`, {
                headers: { 'x-api-key': apiKeyHeader },
                timeout: 600
            });
            result.checkedKeys.add(String(nodeKey));
            result.checkedCount += 1;
            const data = response && response.data ? response.data : {};
            const isOnline = data.status === 'online' || data.online === true || Number.isFinite(Number(data.latency_ms));
            if (isOnline) result.activeKeys.add(nodeKey);
        } catch (e) {}
    }));
    return result;
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

async function fetchExistingUserKeysFallback(user, groupInfo) {
    const apiKeyHeader = resolveApiKey(groupInfo);
    try {
        const basePayload = {
            username: user.name,
            userName: user.name,
            name: user.name,
            totalGB: user.totalGB,
            usedGB: user.usedGB,
            expireDate: user.expireDate,
            masterGroupId: groupInfo.masterGroupId,
            token: user.token,
            userToken: user.token
        };

        const editResponse = await fetchWithRetry(groupInfo.masterIp + '/api/internal/edit-user', basePayload, {
            headers: { 'x-api-key': apiKeyHeader },
            timeout: 20000
        }, 1, 500);
        let keys = pickKeysFromResponsePayload(editResponse && editResponse.data ? editResponse.data : editResponse);
        if (keys) return keys;

        // Fallback for masters that only need identity to return/update keys.
        const minimalResponse = await fetchWithRetry(groupInfo.masterIp + '/api/internal/edit-user', {
            username: user.name,
            userName: user.name,
            name: user.name,
            masterGroupId: groupInfo.masterGroupId
        }, {
            headers: { 'x-api-key': apiKeyHeader },
            timeout: 20000
        }, 1, 500);
        keys = pickKeysFromResponsePayload(minimalResponse && minimalResponse.data ? minimalResponse.data : minimalResponse);
        return keys;
    } catch (e) {
        console.log(`[refresh-fallback] edit-user failed for ${user.name}: ${getErrMsg(e)}`);
        return null;
    }
}

function buildServerLabels(accessKeys, existingLabels) {
    const labels = {};
    const source = (existingLabels && typeof existingLabels === 'object') ? existingLabels : {};
    const keys = (accessKeys && typeof accessKeys === 'object') ? Object.keys(accessKeys) : [];
    for (const key of keys) {
        const oldLabel = source[key];
        const cleaned = (oldLabel && String(oldLabel).trim()) ? String(oldLabel).trim() : '';
        labels[key] = (!cleaned || cleaned === key) ? toDisplayNodeName(key) : cleaned;
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

function buildNodeConfigForUser(user, templateConfig) {
    const template = cloneValue(templateConfig);
    if (!isPlainObject(template)) return template;
    const ownValues = isPlainObject(user && user.accessKeys) ? Object.values(user.accessKeys) : [];
    const ownBase = ownValues.find((v) => isPlainObject(v));
    if (!ownBase) return template;
    const carryFields = ['password', 'method', 'prefix', 'id', 'flow', 'encryption', 'security', 'plugin', 'plugin_opts'];
    for (const field of carryFields) {
        if (ownBase[field] !== undefined) template[field] = ownBase[field];
    }
    return template;
}

async function backfillUserAccessKeysFromGroupTemplates(user, groupInfo) {
    if (!user || !user.groupName) return user;
    const peers = await User.find({ groupName: user.groupName }, { accessKeys: 1, serverLabels: 1 });
    const templates = {};
    for (const p of peers) {
        if (!p || !isPlainObject(p.accessKeys)) continue;
        for (const [nodeKey, cfg] of Object.entries(p.accessKeys)) {
            if (!nodeKey || templates[nodeKey] !== undefined) continue;
            templates[nodeKey] = cloneValue(cfg);
        }
    }

    const existing = isPlainObject(user.accessKeys) ? { ...user.accessKeys } : {};
    let changed = false;
    for (const [nodeKey, cfg] of Object.entries(templates)) {
        if (existing[nodeKey] !== undefined) continue;
        existing[nodeKey] = buildNodeConfigForUser(user, cfg);
        changed = true;
    }
    if (!changed) return user;

    user.accessKeys = existing;
    user.serverLabels = buildServerLabels(existing, user.serverLabels);
    if (!user.currentServer || !existing[user.currentServer]) {
        user.currentServer = Object.keys(existing)[0] || 'None';
    }
    await user.save();
    try { await redisClient.del(user.token); } catch (e) {}
    return user;
}

async function refreshUserNodesFromMaster(user, groupInfo) {
    if (!user || !groupInfo || !groupInfo.masterIp || !groupInfo.masterGroupId) return user;
    const apiKeyHeader = resolveApiKey(groupInfo);
    let masterKeys = null;
    try {
        const masterResponse = await fetchWithRetry(groupInfo.masterIp + '/api/generate-keys', {
            masterGroupId: groupInfo.masterGroupId,
            userName: user.name,
            totalGB: user.totalGB,
            expireDate: user.expireDate,
        }, { headers: { 'x-api-key': apiKeyHeader }, timeout: 8000 }, 1, 500);
        masterKeys = pickKeysFromResponsePayload(masterResponse && masterResponse.data ? masterResponse.data : masterResponse);
    } catch (e) {}
    if (!masterKeys || typeof masterKeys !== 'object' || Object.keys(masterKeys).length === 0) {
        masterKeys = await fetchExistingUserKeysFallback(user, groupInfo);
    }
    if (!masterKeys) return user;

    user.accessKeys = masterKeys;
    user.serverLabels = buildServerLabels(masterKeys, user.serverLabels);
    if (!user.currentServer || !masterKeys[user.currentServer]) {
        user.currentServer = Object.keys(masterKeys)[0] || 'None';
    }
    await user.save();
    try { await redisClient.del(user.token); } catch (e) {}
    return user;
}

async function refreshGroupUsersFromMaster(groupInfo, batchSize = 5) {
    if (!groupInfo || !groupInfo.name) return { refreshed: 0, failed: 0 };
    const users = await User.find({ groupName: groupInfo.name });
    let refreshed = 0;
    let failed = 0;
    for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await Promise.all(batch.map(async (u) => {
            try {
                await refreshUserNodesFromMaster(u, groupInfo);
                refreshed++;
            } catch (e) {
                failed++;
            }
        }));
    }
    return { refreshed, failed };
}

async function fetchGroupNodeLabelMap(groupInfo) {
    const labelMap = {};
    if (!groupInfo || !groupInfo.masterIp || !groupInfo.masterGroupId) return labelMap;
    const apiKeyHeader = resolveApiKey(groupInfo);
    let response;
    try {
        response = await fetchWithRetry(groupInfo.masterIp + '/api/active-groups', null, {
            method: 'get',
            headers: { 'x-api-key': apiKeyHeader },
            timeout: 1200
        }, 1, 300);
    } catch (e) {
        response = await fetchWithRetry(groupInfo.masterIp + '/api/active-groups', {}, {
            method: 'post',
            headers: { 'x-api-key': apiKeyHeader },
            timeout: 1200
        }, 1, 300);
    }
    const groups = (response && response.data && Array.isArray(response.data.groups)) ? response.data.groups : [];
    const targetGroup = groups.find((g) => String(g.id) === String(groupInfo.masterGroupId)) ||
        groups.find((g) => String(g.name) === String(groupInfo.name));
    if (!targetGroup) return labelMap;

    const rawNodes =
        targetGroup.activeNodes ??
        targetGroup.nodes ??
        targetGroup.servers ??
        targetGroup.serverList ??
        targetGroup.activeNodeList ??
        targetGroup.onlineNodes ??
        targetGroup.nodeList;

    const normalizeNode = (n, fallbackId = '') => {
        if (typeof n === 'string') return { id: n, label: n };
        if (!n || typeof n !== 'object') return null;
        const id = n.id || n.serverId || n.nodeId || n.key || fallbackId || n.name || n.serverName || n.nodeName || '';
        const label = n.displayName || n.name || n.serverName || n.nodeName || n.title || id || '';
        if (!id && !label) return null;
        return { id: String(id || label), label: String(label || id) };
    };

    let items = [];
    if (Array.isArray(rawNodes)) {
        items = rawNodes.map((n) => normalizeNode(n)).filter(Boolean);
    } else if (rawNodes && typeof rawNodes === 'object') {
        items = Object.entries(rawNodes).map(([k, v]) => normalizeNode(v, k)).filter(Boolean);
    } else if (typeof rawNodes === 'string' && rawNodes.trim()) {
        items = rawNodes.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ id: s, label: s }));
    }

    for (const item of items) {
        labelMap[item.id] = item.label || item.id;
    }
    return labelMap;
}

userApp.get('/panel/api/ping/:token/:nodeName', async (req, res) => {
    try {
        const { token, nodeName } = req.params;
        const user = await User.findOne({ token: token });
        if (!user) return res.json({ status: 'offline' });
        const group = await findGroupByUserGroupName(user.groupName);
        if (!group || !group.masterIp) return res.json({ status: 'offline' });

        const apiKeyHeader = resolveApiKey(group);
        const url = `${group.masterIp}/api/ping/${encodeURIComponent(nodeName)}`;
        const response = await axios.get(url, { headers: { 'x-api-key': apiKeyHeader }, timeout: 900 });
        res.json(response.data);
    } catch (error) { res.json({ status: 'offline' }); }
});

// Friendly landing for /panel without token.
userApp.get('/panel', (req, res) => {
    res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Panel Link Required</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
            <div class="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl p-6">
                <h1 class="text-xl font-bold mb-3">Panel token လိုအပ်ပါတယ်</h1>
                <p class="text-slate-300 mb-4">
                    ဒီ page ကို အသုံးပြုရန် valid token ပါတဲ့ link နဲ့ဝင်ရပါတယ်။
                </p>
                <div class="bg-slate-800 rounded-xl p-3 font-mono text-sm break-all">
                    https://${req.hostname}/panel/&lt;your-token&gt;
                </div>
            </div>
        </body>
        </html>
    `);
});

// 🌟 USER WEB PANEL
userApp.get('/panel/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const user = await User.findOne({ token: token });
        if(!user) return res.status(404).send("User not found or Invalid Token!");

        const group = await findGroupByUserGroupName(user.groupName);
        // Local-only backfill from group peers (no master API call on panel load).
        try { await backfillUserAccessKeysFromGroupTemplates(user, group); } catch (e) {}
        let nodeLabelMap = {};
        if (group && group.masterIp && group.masterGroupId) {
            try { nodeLabelMap = await fetchGroupNodeLabelMap(group); } catch (e) {}
        }
        const domainName = normalizeHost(group && group.nsRecord) || '';

        const today = new Date(); today.setHours(0, 0, 0, 0); 
        const expDate = new Date(user.expireDate);
        const isExpired = user.usedGB >= user.totalGB || today > expDate;

        const encodedName = encodeURIComponent(user.name.replace(/\s+/g, ''));
        const keyLabel = (group && group.keyLabel) ? group.keyLabel : (group && group.name ? group.name : 'VPN');
        const ssconfLink = domainName
            ? `ssconf://${domainName}/${token}.json#${encodeURIComponent(keyLabel)}_${encodedName}`
            : ''; 

        let nodesListHtml = '';
        let nodeEntries = []; 
        let activeProbe = { activeKeys: new Set(), checkedCount: 0 };
        if (group && group.masterIp && user.accessKeys && Object.keys(user.accessKeys).length > 0) {
            try { activeProbe = await getActiveNodeProbe(group, Object.keys(user.accessKeys)); } catch (e) {}
        }
        
        if (user.accessKeys && Object.keys(user.accessKeys).length > 0) {
            let renderNodeKeys = Object.keys(user.accessKeys);
            if (activeProbe.checkedCount > 0) {
                // Keep nodes that were not ping-checked to avoid hiding new keys on large lists.
                renderNodeKeys = renderNodeKeys.filter((k) => !activeProbe.checkedKeys.has(k) || activeProbe.activeKeys.has(k));
            }
            renderNodeKeys.forEach(serverName => {
                const rawSavedLabel = (user.serverLabels && user.serverLabels[serverName]) ? String(user.serverLabels[serverName]).trim() : '';
                const serverDisplayName = (rawSavedLabel && rawSavedLabel !== serverName)
                    ? rawSavedLabel
                    : (nodeLabelMap[serverName] || toDisplayNodeName(serverName));
                const safeDisplayName = String(serverDisplayName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const safeNodeId = serverName.replace(/[^a-zA-Z0-9_-]/g, '-');
                nodeEntries.push({ key: serverName, safeId: safeNodeId });
                const isSelected = user.currentServer === serverName;
                
                const activeClass = isSelected ? 'bg-indigo-900/30 border-l-4 border-indigo-500' : 'hover:bg-slate-800/50';
                const iconColor = isSelected ? 'text-indigo-400' : 'text-slate-400';
                const checkIcon = isSelected ? `<i class="fas fa-check-circle text-indigo-500 text-lg"></i>` : `<i class="fas fa-arrow-circle-right text-slate-600 hover:text-slate-400 transition text-lg"></i>`;
                const disabledButtonClass = isExpired ? 'opacity-60 cursor-not-allowed' : '';

                nodesListHtml += `
                <form id="form-${safeNodeId}" action="/panel/change-server" method="POST" class="m-0 border-b border-slate-800 last:border-0">
                    <input type="hidden" name="token" value="${token}">
                    <input type="hidden" name="newServer" value="${serverName}">
                    <button type="button" ${isSelected ? '' : `onclick="confirmSwitch('form-${safeNodeId}', '${safeDisplayName}')"`} class="w-full flex justify-between items-center p-4 transition-all duration-200 ${activeClass} ${isSelected ? 'cursor-default' : ''} ${disabledButtonClass}">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700"><i class="fas fa-globe ${iconColor} text-sm"></i></div>
                            <div class="flex flex-col items-start leading-tight">
                                <span class="font-bold ${isSelected ? 'text-white' : 'text-slate-300'} text-[15px] tracking-wide">${serverDisplayName}</span>
                            </div>
                        </div>
                        <div class="flex items-center gap-4">
                            <span id="ping-${safeNodeId}" class="text-xs font-semibold text-slate-500 w-16 text-right tracking-wider"><i class="fas fa-circle-notch fa-spin text-slate-600"></i></span>
                            ${checkIcon}
                        </div>
                    </button>
                </form>`;
            });
            if (renderNodeKeys.length === 0) {
                nodesListHtml = `<div class="p-6 text-center text-slate-500 font-medium">No Active Servers Available</div>`;
            }
        } else { nodesListHtml = `<div class="p-6 text-center text-slate-500 font-medium">No Servers Available</div>`; }

        const usagePercent = user.totalGB > 0 ? ((user.usedGB / user.totalGB) * 100).toFixed(1) : 0;
        const progressColor = isExpired ? 'from-red-600 to-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]' : 'from-indigo-600 via-indigo-500 to-purple-500 shadow-[0_0_15px_rgba(99,102,241,0.6)]';
        const logoUrl = "https://i.postimg.cc/G2FPpD7C/QUITO-profile-1.png"; 
        const outlineIconUrl = "https://i.postimg.cc/rm7q3wKz/images-(23).jpg";
        const panelBadgeText = (group && group.panelLabel ? String(group.panelLabel).trim() : 'Premium') || 'Premium';
        const rawServerNote = (group && group.panelServerNote) ? String(group.panelServerNote).trim() : '';

        let alertCardHtml = '';
        if (isExpired) {
            alertCardHtml = `
                <div class="bg-red-500/10 border border-red-500/50 rounded-3xl p-6 mb-6 text-center shadow-[0_0_30px_rgba(239,68,68,0.15)] relative overflow-hidden">
                    <div class="absolute top-0 right-0 w-32 h-32 bg-red-500/20 rounded-full blur-3xl -mr-10 -mt-10"></div>
                    <div class="relative z-10">
                        <div class="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.3)]"><i class="fas fa-ban text-red-400 text-3xl animate-pulse"></i></div>
                        <h3 class="text-xl font-black text-white mb-2 tracking-tight">Package ကုန်ဆုံးသွားပါပြီ</h3>
                        <p class="text-red-300 text-[13px] font-bold mb-6 leading-relaxed px-2">သင်၏ Data ပမာဏ (သို့) သက်တမ်း ကုန်ဆုံးသွားပါသည်။ ကျေးဇူးပြု၍ Admin ထံ ဆက်သွယ်ပြီး သက်တမ်းတိုးပါ။</p>
                        <div class="flex gap-3 justify-center">
                            <a href="http://m.me/qitotechmm" target="_blank" class="flex-1 bg-[#0084FF] hover:bg-[#0073e6] text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(0,132,255,0.4)] active:scale-[0.98] flex items-center justify-center gap-2"><i class="fab fa-facebook-messenger text-lg"></i> Messenger</a>
                            <a href="http://t.me/qitoadmin" target="_blank" class="flex-1 bg-[#0088cc] hover:bg-[#007ab8] text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(0,136,204,0.4)] active:scale-[0.98] flex items-center justify-center gap-2"><i class="fab fa-telegram-plane text-lg"></i> Telegram</a>
                        </div>
                    </div>
                </div>`;
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>QITO Tech Premium</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
                <style>body { background-color: #0b1121; }</style>
            </head>
            <body class="text-slate-200 font-sans min-h-screen pb-10 selection:bg-indigo-500 selection:text-white">
                <div class="max-w-md mx-auto px-4 pt-8">
                    <div class="flex justify-between items-center mb-6">
                        <div class="flex items-center gap-4">
                            <img src="${logoUrl}" alt="Logo" class="w-12 h-12 rounded-full border-2 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.3)] object-cover bg-slate-800">
                            <div>
                                <h1 class="text-xl font-black text-white tracking-tight leading-tight">QITO Tech</h1>
                                <p class="text-xs font-black text-indigo-400 tracking-widest uppercase">Premium VPN</p>
                            </div>
                        </div>
                        <div class="bg-slate-800/90 px-3 py-1.5 rounded-xl border border-cyan-500/30 shadow-[0_0_15px_rgba(34,211,238,0.25)] flex items-center gap-2">
                            <i class="fas fa-gem text-cyan-400 text-[13px] animate-spin" style="animation-duration: 3s; filter: drop-shadow(0 0 6px #22d3ee);"></i>
                            <span class="text-[11px] font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-400 uppercase tracking-widest">${panelBadgeText}</span>
                        </div>
                    </div>

                    <div class="mb-5 ml-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span class="text-2xl sm:text-3xl font-black text-slate-300 tracking-wide">Username:</span>
                        <span class="text-[30px] font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-200 via-yellow-400 to-amber-500 drop-shadow-[0_0_14px_rgba(250,204,21,0.7)] tracking-wide uppercase">${user.name}</span>
                    </div>

                    <div class="bg-[#151f32] rounded-3xl p-6 shadow-xl border border-slate-800 mb-6 relative overflow-hidden">
                        <div class="absolute top-0 right-0 w-40 h-40 bg-indigo-500/10 rounded-full blur-3xl -mr-10 -mt-10"></div>
                        <div class="flex justify-between items-end mb-3 relative z-10">
                            <div>
                                <p class="text-xs text-slate-400 font-bold uppercase tracking-widest mb-1.5">Data Usage</p>
                                <div class="text-4xl font-black text-white">${user.usedGB} <span class="text-base text-slate-500 font-bold">/ ${user.totalGB} GB</span></div>
                            </div>
                        </div>
                        <div class="w-full bg-slate-800 rounded-full h-3 mt-4 relative z-10 overflow-hidden shadow-inner">
                            <div class="bg-gradient-to-r ${progressColor} h-3 rounded-full" style="width: ${usagePercent}%"></div>
                        </div>
                        <div class="mt-5 pt-5 border-t border-slate-800 flex justify-between items-center relative z-10">
                            <span class="text-[13px] font-bold text-slate-500"><i class="far fa-calendar-alt mr-1.5 text-slate-600"></i> Expires On</span>
                            <span class="text-[13px] font-black ${isExpired ? 'text-red-500' : 'text-yellow-500'}">${user.expireDate}</span>
                        </div>
                    </div>

                    ${alertCardHtml}

                    <div class="mb-3">
                        <a href="${ssconfLink}" class="w-full bg-[#151f32] hover:bg-slate-800 border border-slate-700 text-slate-200 font-bold py-4 px-2 rounded-2xl flex items-center justify-center gap-3 transition active:scale-[0.98] shadow-md">
                            <img src="${outlineIconUrl}" class="w-6 h-6 rounded object-cover shadow-sm"><span class="tracking-wide text-[15px]">Open With Outline VPN</span>
                        </a>
                    </div>
                    <button id="copyBtn" onclick="copyLink('${ssconfLink}')" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-2xl shadow-[0_6px_20px_rgba(79,70,229,0.35)] mb-8 transition-all active:scale-[0.98] flex justify-center items-center gap-2.5 uppercase tracking-wider text-sm">
                        <i class="fas fa-copy text-lg"></i> Copy Outline VPN Key
                    </button>

                    <div class="bg-[#151f32] rounded-3xl overflow-hidden shadow-xl border border-slate-800">
                        ${rawServerNote ? `<div class="bg-slate-800/30 p-4 text-[13px] font-bold text-slate-300 border-b border-slate-800 flex items-center justify-center gap-2">${rawServerNote.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
                        <div class="flex flex-col">${nodesListHtml}</div>
                    </div>
                </div>
                
                <div id="switchModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-[#0b1121]/80 backdrop-blur-md opacity-0 transition-opacity duration-300">
                    <div class="bg-[#151f32] border border-slate-700 rounded-[2rem] p-8 w-[85%] max-w-sm shadow-[0_0_40px_rgba(0,0,0,0.5)] transform scale-95 transition-transform duration-300 relative overflow-hidden" id="modalContent">
                        <div class="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 bg-indigo-500/20 rounded-full blur-3xl -mt-10"></div>
                        <div class="text-center relative z-10">
                            <div class="w-20 h-20 bg-indigo-500/10 rounded-full flex items-center justify-center mx-auto mb-5 border border-indigo-500/30 shadow-[0_0_20px_rgba(99,102,241,0.2)]"><i class="fas fa-exchange-alt text-indigo-400 text-3xl"></i></div>
                            <h3 class="text-2xl font-black text-white mb-2 tracking-tight">Switch Server?</h3>
                            <p class="text-slate-400 text-[15px] mb-8 leading-relaxed">Are you sure you want to connect to <br><b id="modalServerName" class="text-indigo-400 text-lg tracking-wide block mt-1">Server</b></p>
                            <div class="flex gap-3">
                                <button onclick="closeModal()" class="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-3.5 rounded-2xl transition active:scale-[0.98]">Cancel</button>
                                <button id="confirmBtn" class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(79,70,229,0.4)] active:scale-[0.98]">Confirm</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="successModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-[#0b1121]/80 backdrop-blur-md opacity-0 transition-opacity duration-300">
                    <div class="bg-[#151f32] border border-green-500/40 rounded-[2rem] p-8 w-[85%] max-w-sm shadow-[0_0_40px_rgba(34,197,94,0.25)] transform scale-95 transition-transform duration-300 relative overflow-hidden" id="successModalContent">
                        <div class="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 bg-green-500/20 rounded-full blur-3xl -mt-10"></div>
                        <div class="text-center relative z-10">
                            <div class="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-5 border border-green-500/30 shadow-[0_0_20px_rgba(34,197,94,0.2)]"><i class="fas fa-check text-green-400 text-4xl"></i></div>
                            <h3 class="text-xl font-black text-white mb-3 tracking-tight">Server Changed!</h3>
                            <div class="bg-green-900/30 border border-green-500/30 rounded-xl p-4 mb-6">
                                <p class="text-green-400 font-bold text-[14px] leading-relaxed">ကျေးဇူးပြု၍ Outline App ထဲတွင် Key အား ဖြုတ်ပြီး ပြန်ချိတ်ပေးပါ။</p>
                            </div>
                            <button onclick="closeSuccessModal()" class="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_4px_15px_rgba(34,197,94,0.4)] active:scale-[0.98]">OK, Got it!</button>
                        </div>
                    </div>
                </div>

                <script>
                    const nodes = ${JSON.stringify(nodeEntries)}; const token = '${token}'; const isExpiredAccount = ${isExpired ? 'true' : 'false'}; const currentServerKey = '${(user.currentServer || '').replace(/'/g, "\\'")}'; let currentFormId = '';
                    window.onload = function() {
                        const urlParams = new URLSearchParams(window.location.search);
                        if (urlParams.get('switched') === 'true') {
                            const sm = document.getElementById('successModal'); const sc = document.getElementById('successModalContent');
                            sm.classList.remove('hidden'); sm.classList.add('flex');
                            setTimeout(() => { sm.classList.remove('opacity-0'); sc.classList.remove('scale-95'); }, 10);
                            window.history.replaceState({}, document.title, window.location.pathname);
                            return;
                        }
                        if (urlParams.get('expired') === 'true') {
                            alert('Package expired ဖြစ်နေသောကြောင့် server change မလုပ်နိုင်သေးပါ။ Admin ထံ ဆက်သွယ်ပြီး renew ပြုလုပ်ပါ။');
                            window.history.replaceState({}, document.title, window.location.pathname);
                        }
                    };
                    function closeSuccessModal() {
                        const sm = document.getElementById('successModal'); const sc = document.getElementById('successModalContent');
                        sm.classList.add('opacity-0'); sc.classList.add('scale-95');
                        setTimeout(() => { sm.classList.add('hidden'); sm.classList.remove('flex'); }, 300);
                    }
                    function confirmSwitch(formId, serverName) {
                        if (isExpiredAccount) {
                            alert('Package expired ဖြစ်နေသောကြောင့် server change မလုပ်နိုင်သေးပါ။ Admin ထံ ဆက်သွယ်ပြီး renew ပြုလုပ်ပါ။');
                            return;
                        }
                        currentFormId = formId; document.getElementById('modalServerName').innerText = serverName;
                        const modal = document.getElementById('switchModal'); const content = document.getElementById('modalContent');
                        modal.classList.remove('hidden'); modal.classList.add('flex');
                        setTimeout(() => { modal.classList.remove('opacity-0'); content.classList.remove('scale-95'); }, 10);
                    }
                    function closeModal() {
                        const modal = document.getElementById('switchModal'); const content = document.getElementById('modalContent');
                        modal.classList.add('opacity-0'); content.classList.add('scale-95');
                        setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 300);
                    }
                    document.getElementById('confirmBtn').addEventListener('click', () => {
                        if(currentFormId) { document.getElementById('confirmBtn').innerHTML = '<i class="fas fa-circle-notch fa-spin text-xl"></i>'; document.getElementById(currentFormId).submit(); }
                    });
                    async function fetchPings() {
                        if (nodes.length === 0) return;
                        let currentIsOnline = false;
                        let lastOnlineNode = null;
                        for(let node of nodes) {
                            try {
                                let res = await fetch('/panel/api/ping/' + token + '/' + encodeURIComponent(node.key));
                                let data = await res.json();
                                let pingEl = document.getElementById('ping-' + node.safeId);
                                if(pingEl && data.status === 'online' && data.latency_ms) {
                                    let latency = Math.round(data.latency_ms); let color = latency < 100 ? 'text-green-400' : (latency < 200 ? 'text-yellow-400' : 'text-red-400');
                                    pingEl.innerHTML = \`<span class="\${color} font-bold drop-shadow-[0_0_5px_rgba(0,0,0,0.5)]"><i class="fas fa-signal text-[10px] mr-1"></i>\${latency} ms</span>\`;
                                    lastOnlineNode = node;
                                    if (node.key === currentServerKey) currentIsOnline = true;
                                } else if (pingEl) { pingEl.innerHTML = '<span class="text-slate-600 font-bold text-[11px] uppercase">Offline</span>'; }
                            } catch(e) {
                                let pingEl = document.getElementById('ping-' + node.safeId);
                                if (pingEl) pingEl.innerHTML = '<span class="text-slate-700 text-[11px]">Error</span>';
                            }
                        }
                        if (!currentIsOnline && lastOnlineNode && !isExpiredAccount) {
                            let form = document.getElementById('form-' + lastOnlineNode.safeId);
                            if (form) form.submit();
                        }
                    }
                    function copyLink(rawLink) { 
                        const cleanLink = rawLink.trim();
                        const showSuccess = () => {
                            var btn = document.getElementById('copyBtn'); 
                            btn.innerHTML = '<i class="fas fa-check-circle text-lg"></i> LINK COPIED!'; 
                            btn.classList.replace('bg-indigo-600', 'bg-teal-500'); btn.classList.replace('hover:bg-indigo-500', 'hover:bg-teal-400');
                            btn.classList.replace('shadow-[0_6px_20px_rgba(79,70,229,0.35)]', 'shadow-[0_6px_20px_rgba(20,184,166,0.35)]');
                            setTimeout(() => { 
                                btn.innerHTML = '<i class="fas fa-copy text-lg"></i> Copy Subscription Link'; 
                                btn.classList.replace('bg-teal-500', 'bg-indigo-600'); btn.classList.replace('hover:bg-teal-400', 'hover:bg-indigo-500');
                                btn.classList.replace('shadow-[0_6px_20px_rgba(20,184,166,0.35)]', 'shadow-[0_6px_20px_rgba(79,70,229,0.35)]');
                            }, 3000); 
                        };
                        if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(cleanLink).then(showSuccess); } 
                        else {
                            let t = document.createElement("textarea"); t.value = cleanLink; t.style.position = "fixed"; t.style.opacity = "0";
                            document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); showSuccess();
                        }
                    }
                    setTimeout(fetchPings, 500);
                </script>
            </body>
            </html>
        `);
    } catch (error) { res.status(500).send("System Error"); }
});

userApp.post('/panel/change-server', async (req, res) => {
    try {
        const { token, newServer } = req.body;
        const user = await User.findOne({ token: token });
        if (!user) return res.status(404).send("User not found");

        if (user.currentServer === newServer) {
            return res.redirect('/panel/' + token);
        }
        
        const today = new Date(); today.setHours(0, 0, 0, 0); 
        const expDate = new Date(user.expireDate);
        const isExpired = user.usedGB >= user.totalGB || today > expDate;
        if (isExpired) {
            return res.redirect('/panel/' + token + '?expired=true');
        }
        
        const groupInfo = await findGroupByUserGroupName(user.groupName);
        if (!groupInfo) return res.status(404).send("Group Error");

        const apiKeyHeader = resolveApiKey(groupInfo);

        if (!user.accessKeys || !user.accessKeys[newServer]) {
            try {
                await refreshUserNodesFromMaster(user, groupInfo);
            } catch (err) {}
        }
        if (!user.accessKeys || !user.accessKeys[newServer]) {
            return res.status(400).send("Selected server is no longer available.");
        }
        user.currentServer = newServer; await user.save();
        try { await redisClient.del(token); } catch(e){}
        try { await fetchWithRetry(groupInfo.masterIp + '/api/webhook/switch', { token: token, activeServer: newServer }, { headers: { 'x-api-key': apiKeyHeader } }); } catch (err) {}
        
        res.redirect('/panel/' + token + (isExpired ? '' : '?switched=true'));
    } catch (error) { res.status(500).send("Error Changing Server"); }
});

// Backward compatibility: some old keys use /<token> (without .json).
// Keep this broad route safe by validating token format at runtime.
userApp.get('/:token', async (req, res, next) => {
    const token = String(req.params.token || '').trim();
    if (!/^[A-Za-z0-9]{16,64}$/.test(token)) return next();
    return res.redirect(302, `/${token}.json`);
});

// 🌟 OUTLINE SUBSCRIPTION API (THE ULTIMATE JSON FIX) 🌟
userApp.get('/:token.json', async (req, res) => {
    try {
        const token = req.params.token;
        const user = await User.findOne({ token: token });
        if (!user) return res.status(404).json({ error: "Configuration Not Found" });

        const today = new Date(); today.setHours(0, 0, 0, 0); 
        const expDate = new Date(user.expireDate);
        const isExpired = user.usedGB >= user.totalGB || today > expDate;
        const blockExpiredSubscription = String(process.env.BLOCK_EXPIRED_SUBSCRIPTION || '').toLowerCase() === 'true';

        // Default is soft mode: allow JSON even when expired.
        // Set BLOCK_EXPIRED_SUBSCRIPTION=true to restore hard-block behavior.
        if (isExpired && blockExpiredSubscription) {
            const errorJson = {
                error: {
                    message: "⛔️ ဝယ်ယူထားသော Package မှာကုန်ဆုံးသွားပြီဖြစ်ပါတယ်။ Admin ထံ ဆက်သွယ်ပြီး Package အသစ်ဝယ်ယူနိုင်ပါတယ်။",
                    details: "Package ဝယ်ယူရန် http://t.me/qitoadmin သို့မဟုတ် http://m.me/qitotechmm ကိုဆက်သွယ်နိုင်ပါတယ်။\n\nQITO Tech Premium VPN မှ အကောင်းဆုံး ဝန်ဆောင်မှုများ ဆက်လက်ပေးရန် အဆင်သင့်ရှိနေပါသည်။"
                }
            };
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.status(200).send(JSON.stringify(errorJson));
        }

        const cachedKey = await redisClient.get(token);
        if (cachedKey) { 
            try {
                const parsed = JSON.parse(cachedKey);
                const looksLikeExpiredError = !!(parsed && parsed.error && typeof parsed.error === 'object' &&
                    /package|expire|ကုန်ဆုံး/i.test(String(parsed.error.message || '')));
                if (!looksLikeExpiredError) {
                    return res.json(parsed);
                }
                await redisClient.del(token);
            } catch (e) {
                await redisClient.del(token);
            } 
        }

        const allNodeKeys = (user.accessKeys && typeof user.accessKeys === 'object') ? Object.keys(user.accessKeys) : [];
        const selectedServer = (user.currentServer && user.accessKeys && user.accessKeys[user.currentServer])
            ? user.currentServer
            : (allNodeKeys[0] || '');

        if (selectedServer && user.accessKeys && user.accessKeys[selectedServer]) {
            let rawConfig = user.accessKeys[selectedServer];
            if (typeof rawConfig === 'string' && rawConfig.startsWith('{')) { try { rawConfig = JSON.parse(rawConfig); } catch(e){} }
            if (typeof rawConfig === 'string' && rawConfig.startsWith('ss://')) { return res.json({ server: rawConfig }); }

            // Keep full master-issued config fields (e.g. prefix/plugin/security).
            // Trimming to only {server,port,password,method} can break connectivity on some nodes.
            if (rawConfig && typeof rawConfig === 'object' && rawConfig.server_port !== undefined) {
                const portNum = Number(rawConfig.server_port);
                if (Number.isFinite(portNum)) rawConfig.server_port = portNum;
            }
            await redisClient.setEx(token, 300, JSON.stringify(rawConfig));
            return res.json(rawConfig);
        }
        res.status(404).json({ error: "Configuration Not Found" });
    } catch (error) { res.status(500).json({ error: "System Error" }); }
});

function normalizeCandidate(value) {
    return String(value || '').trim();
}

function normalizeLooseIdentity(value) {
    let v = String(value || '').trim();
    try { v = decodeURIComponent(v); } catch (e) {}
    return v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_-]/g, '');
}

function toDisplayNodeName(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'Unknown Node';
    const m = raw.match(/(?:^|[_-])server[_-]?(\d+)$/i);
    if (m) return `Server ${m[1]}`;
    return raw
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeHost(value) {
    const raw = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!raw) return '';
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    return withoutScheme.split('/')[0].replace(/:\d+$/, '').trim().replace(/\.$/, '');
}

async function findGroupByUserGroupName(groupName) {
    const raw = String(groupName || '').trim();
    if (!raw) return null;
    const direct = await Group.findOne({ name: raw });
    if (direct) return direct;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Group.findOne({ name: { $regex: `^${escaped}$`, $options: 'i' } });
}

function extractLikelyToken(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) return '';
    const jsonMatch = raw.match(/\/([A-Za-z0-9]{16,64})\.json/i);
    if (jsonMatch) return jsonMatch[1];
    const panelMatch = raw.match(/\/panel\/([A-Za-z0-9]{16,64})/i);
    if (panelMatch) return panelMatch[1];
    if (/^[A-Za-z0-9]{16,64}$/.test(raw)) return raw;
    return '';
}

function flattenPayload(input, out = {}) {
    if (!input || typeof input !== 'object') return out;
    for (const [k, v] of Object.entries(input)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
            flattenPayload(v, out);
        } else if (typeof v !== 'function') {
            const key = String(k).toLowerCase();
            if (out[key] === undefined) out[key] = v;
        }
    }
    return out;
}

function getFirstValue(lookup, keys = []) {
    for (const key of keys) {
        const v = lookup[String(key).toLowerCase()];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function parseStrictNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const s = value.trim();
        if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    }
    return undefined;
}

function makeBadRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
    }
    return undefined;
}

function readStrictNumericField(lookup, aliases, label) {
    const raw = getFirstValue(lookup, aliases);
    if (raw === undefined) return undefined;
    const parsed = parseStrictNumber(raw);
    if (parsed === undefined) throw makeBadRequest(`Invalid ${label}: numeric value required`);
    return parsed;
}

function toGbFromBytes(value) {
    const n = toNumber(value);
    if (n === undefined) return undefined;
    return Number((n / (1024 * 1024 * 1024)).toFixed(3));
}

async function syncUserUsageHandler(req, res) {
    try {
        const payload = {
            ...(req.query || {}),
            ...(req.body || {}),
            ...((req.body && typeof req.body.data === 'object') ? req.body.data : {}),
            identifier: req.params && req.params.identifier ? req.params.identifier : undefined
        };
        const lookup = flattenPayload(payload);
        const fallbackIdentifier = req.params && req.params.identifier ? req.params.identifier : '';
        const token = normalizeCandidate(getFirstValue(lookup, ['token', 'usertoken', 'accesstoken', 'uuid']) || fallbackIdentifier);
        const name = normalizeCandidate(getFirstValue(lookup, ['name', 'username', 'user', 'username']) || fallbackIdentifier);

        if (!name) {
            throw makeBadRequest('Invalid payload: name is required');
        }

        let user = null;
        if (token) {
            user = await User.findOne({ token });
        }
        if (!user && name) {
            user = await User.findOne({ name });
        }

        if (!user) {
            console.warn('[sync-user-usage] user not found', {
                identifier: req.params && req.params.identifier,
                keys: Object.keys(lookup || {})
            });
            return res.status(404).json({ success: false, error: "User not found locally" });
        }

        let usedGb = readStrictNumericField(lookup, ['usedgb', 'used', 'usagegb', 'trafficgb'], 'usedGB');
        let totalGb = readStrictNumericField(lookup, ['totalgb', 'total', 'quota', 'quotagb'], 'totalGB');
        const remainingGb = readStrictNumericField(lookup, ['remaininggb', 'remaining', 'leftgb'], 'remainingGB');
        const usedBytes = readStrictNumericField(lookup, ['usedbytes', 'usedbyte', 'trafficbytes', 'usagebytes'], 'usedBytes');
        const totalBytes = readStrictNumericField(lookup, ['totalbytes', 'quotabytes'], 'totalBytes');
        const uploadBytes = readStrictNumericField(lookup, ['uploadbytes', 'uplinkbytes', 'upbytes'], 'uploadBytes');
        const downloadBytes = readStrictNumericField(lookup, ['downloadbytes', 'downlinkbytes', 'downbytes'], 'downloadBytes');
        const expireDate = getFirstValue(lookup, ['expiredate', 'expirydate', 'expiresat', 'expire']);
        const isBlockedRaw = getFirstValue(lookup, ['isblocked', 'blocked']);

        if (usedGb === undefined && usedBytes !== undefined) usedGb = toGbFromBytes(usedBytes);
        if (totalGb === undefined && totalBytes !== undefined) totalGb = toGbFromBytes(totalBytes);

        if (usedGb === undefined && (uploadBytes !== undefined || downloadBytes !== undefined)) {
            const up = toNumber(uploadBytes) || 0;
            const down = toNumber(downloadBytes) || 0;
            usedGb = toGbFromBytes(up + down);
        }

        if (usedGb === undefined && remainingGb !== undefined && totalGb !== undefined) {
            usedGb = Number((totalGb - remainingGb).toFixed(3));
        }

        if (usedGb === undefined) {
            throw makeBadRequest('Invalid usedGB: numeric value required');
        }

        const parsedBlocked = parseBoolean(isBlockedRaw);
        if (isBlockedRaw !== undefined && parsedBlocked === undefined) {
            throw makeBadRequest('Invalid isBlocked: boolean value required');
        }

        if (expireDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(expireDate))) {
            throw makeBadRequest('Invalid expireDate: expected YYYY-MM-DD');
        }

        if (usedGb !== undefined) user.usedGB = usedGb;
        if (totalGb !== undefined) user.totalGB = totalGb;
        if (remainingGb !== undefined) user.remainingGB = remainingGb;
        if (parsedBlocked !== undefined) user.isBlocked = parsedBlocked;
        if (expireDate !== undefined) user.expireDate = String(expireDate);
        
        await user.save();
        console.log('[sync-user-usage] updated', { user: user.name, usedGB: user.usedGB, totalGB: user.totalGB });
        return res.json({ success: true, message: "Usage synced successfully" });
    } catch (error) {
        const status = error && error.statusCode ? error.statusCode : 500;
        const message = status === 500 ? "Server Error" : error.message;
        return res.status(status).json({ success: false, error: message });
    }
}

// 🌟 SYNC USER USAGE WEBHOOK FALLBACK (DUAL ROUTE) 🌟
userApp.post('/api/internal/sync-user-usage', syncUserUsageHandler);
userApp.post('/api/internal/sync-user-usage/:identifier', syncUserUsageHandler);
userApp.get('/api/internal/sync-user-usage', syncUserUsageHandler);
userApp.get('/api/internal/sync-user-usage/:identifier', syncUserUsageHandler);
userApp.post('/sync-user-usage', syncUserUsageHandler);
userApp.get('/sync-user-usage', syncUserUsageHandler);
userApp.post('/admin/api/internal/sync-user-usage', requireApiKey, syncUserUsageHandler);
userApp.post('/admin/api/internal/sync-user-usage/:identifier', requireApiKey, syncUserUsageHandler);
userApp.get('/admin/api/internal/sync-user-usage', requireApiKey, syncUserUsageHandler);
userApp.get('/admin/api/internal/sync-user-usage/:identifier', requireApiKey, syncUserUsageHandler);

async function syncNewServerHandler(req, res) {
    try {
        const payload = {
            ...(req.body || {}),
            ...((req.body && typeof req.body.data === 'object') ? req.body.data : {})
        };
        const lookup = flattenPayload(payload);
        const masterGroupId = normalizeCandidate(getFirstValue(lookup, ['mastergroupid']));
        const groupName = normalizeCandidate(getFirstValue(lookup, ['groupname', 'name']));
        const newServerName = normalizeCandidate(getFirstValue(lookup, ['newservername']));
        const newServerId = normalizeCandidate(getFirstValue(lookup, ['newserverid']));
        const newServerDisplayName = normalizeCandidate(getFirstValue(lookup, ['newserverdisplayname']));
        const webhookVersion = normalizeCandidate(getFirstValue(lookup, ['version', 'webhookversion', 'syncversion']));
        const webhookEventAt = normalizeCandidate(getFirstValue(lookup, ['at', 'eventat', 'updatedat', 'timestamp']));
        const userKeys = payload.userKeys && typeof payload.userKeys === 'object' ? payload.userKeys : payload.userkeys;
        const serverKey = newServerId || newServerName;
        const serverLabel = newServerDisplayName || serverKey;
        const approxUserKeyEntries = (userKeys && typeof userKeys === 'object' && !Array.isArray(userKeys))
            ? Object.keys(userKeys).length
            : 0;
        console.log('[sync-new-server] webhook received', {
            path: req.originalUrl || req.path,
            method: req.method,
            masterGroupId,
            groupName,
            webhookVersion,
            serverKey,
            serverLabel,
            userKeyEntries: approxUserKeyEntries
        });
        if (!masterGroupId) {
            console.warn('[sync-new-server] invalid payload', {
                reason: 'missing-masterGroupId',
                groupName,
                serverKey
            });
            return res.status(400).json({ error: 'masterGroupId is required' });
        }
        if (!serverKey || !userKeys || typeof userKeys !== 'object') {
            console.warn('[sync-new-server] invalid payload', {
                masterGroupId,
                groupName,
                serverKey,
                hasUserKeysObject: !!(userKeys && typeof userKeys === 'object')
            });
            return res.status(400).json({ error: "Invalid payload data" });
        }

        const validGroup = await Group.findOne({ masterGroupId: masterGroupId });
        console.log('[sync-new-server] group lookup', {
            masterGroupId,
            groupName,
            groupMatched: !!validGroup,
            resolvedBy: validGroup ? 'masterGroupId' : 'none',
            resolvedGroupName: validGroup ? validGroup.name : null
        });
        // Strict mode: masterGroupId must map to an existing local group.
        if (!validGroup) {
            console.warn('[sync-new-server] unauthorized request', {
                masterGroupId,
                groupName,
                reason: 'masterGroupId-not-found',
                tip: 'ensure masterGroupId matches local Group.masterGroupId'
            });
            return res.status(404).json({ error: 'Group not found for masterGroupId' });
        }
        if (groupName && String(validGroup.name || '').toLowerCase() !== String(groupName).toLowerCase()) {
            console.warn('[sync-new-server] group identity mismatch', {
                masterGroupId,
                payloadGroupName: groupName,
                localGroupName: validGroup.name
            });
            return res.status(400).json({ error: 'groupName does not match masterGroupId mapping' });
        }
        try {
            await Group.updateOne(
                { _id: validGroup._id },
                {
                    $set: {
                        lastWebhookVersion: webhookVersion || '',
                        lastWebhookServerId: serverKey || '',
                        lastWebhookReceivedAt: new Date(),
                        lastWebhookEventAt: webhookEventAt || ''
                    }
                }
            );
        } catch (e) {}

        const normalizedServerPayload =
            userKeys && typeof userKeys === 'object' && !Array.isArray(userKeys)
                ? userKeys
                : {};
        let userConfigMap = normalizedServerPayload;
        // Support nested payload shape: userKeys: { "<serverId>": { "<identifier>": <config> } }
        if (!Object.values(normalizedServerPayload).some((v) => typeof v === 'string' || (v && typeof v === 'object' && (v.server || v.password)))) {
            const nestedCandidate = normalizedServerPayload[serverKey] || normalizedServerPayload[newServerName];
            if (nestedCandidate && typeof nestedCandidate === 'object' && !Array.isArray(nestedCandidate)) {
                userConfigMap = nestedCandidate;
            }
        }
        console.log('[sync-new-server] payload normalized', {
            serverKey,
            configEntries: Object.keys(userConfigMap || {}).length
        });

        const groupUsers = validGroup ? await User.find({ groupName: validGroup.name }, { _id: 1, token: 1, name: 1 }) : [];
        const byToken = new Map();
        const byNameExact = new Map();
        const byNameLoose = new Map();
        for (const gu of groupUsers) {
            byToken.set(String(gu.token || ''), gu);
            byNameExact.set(String(gu.name || '').toLowerCase(), gu);
            byNameLoose.set(normalizeLooseIdentity(gu.name || ''), gu);
        }

        let successCount = 0;
        let unmatchedCount = 0;
        for (const [identifierRaw, newConfig] of Object.entries(userConfigMap)) {
            const identifier = String(identifierRaw || '').trim();
            const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const likelyToken = extractLikelyToken(identifier);
            let user =
                byToken.get(identifier) ||
                (likelyToken ? byToken.get(likelyToken) : null) ||
                byNameExact.get(identifier.toLowerCase()) ||
                byNameLoose.get(normalizeLooseIdentity(identifier));

            if (!user) {
                const queryOr = [{ token: identifier }, { name: new RegExp('^' + escapedIdentifier + '$', 'i') }];
                if (likelyToken) queryOr.unshift({ token: likelyToken });
                user = await User.findOne({ $or: queryOr });
            }

            if (user) {
                const updateQuery = {
                    [`accessKeys.${serverKey}`]: newConfig
                };
                if (serverLabel) {
                    updateQuery[`serverLabels.${serverKey}`] = serverLabel;
                }
                await User.updateOne({ _id: user._id }, { $set: updateQuery });
                try { await redisClient.del(user.token); } catch(e){}
                successCount++;
            } else {
                unmatchedCount++;
            }
        }
        const refreshedSummary = { refreshed: 0, failed: 0 };
        console.log('[sync-new-server] completed', {
            masterGroupId,
            groupName: validGroup ? validGroup.name : null,
            webhookVersion,
            serverKey,
            successCount,
            unmatchedCount,
            refreshedUsers: refreshedSummary.refreshed,
            refreshFailed: refreshedSummary.failed
        });
        return res.json({
            success: true,
            message: `Server synced successfully for ${successCount} users`,
            refreshedUsers: refreshedSummary.refreshed,
            refreshFailed: refreshedSummary.failed,
            unmatchedIdentifiers: unmatchedCount
        });
    } catch (error) {
        console.error('[sync-new-server] handler failed', error && error.message ? error.message : error);
        res.status(500).json({ error: "Server Error" });
    }
}

userApp.post('/api/internal/sync-new-server', requireApiKey, syncNewServerHandler);
userApp.post('/sync-new-server', requireApiKey, syncNewServerHandler);
userApp.post('/admin/api/internal/sync-new-server', requireApiKey, syncNewServerHandler);

// Pull-based traffic fallback API (old behavior compatible).
userApp.get('/api/traffic/:userId', requireApiKey, async (req, res) => {
    try {
        const userId = String(req.params.userId || '').trim();
        const metricsBaseUrl = String(process.env.VPN_API_URL || '').trim().replace(/\/$/, '');
        const metricsPath = String(process.env.VPN_METRICS_PATH || '/metrics/transfer').trim();
        const upstreamApiKey = String(process.env.VPN_API_KEY || process.env.PANELMASTER_API_KEY || '').trim();

        if (!userId) {
            return res.status(400).json({ success: false, error: 'Missing userId' });
        }
        if (!metricsBaseUrl) {
            return res.status(500).json({ success: false, error: 'VPN_API_URL is not configured' });
        }

        const targetUrl = `${metricsBaseUrl}${metricsPath.startsWith('/') ? metricsPath : `/${metricsPath}`}`;
        const metricsResponse = await axios.get(targetUrl, {
            timeout: 6000,
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: upstreamApiKey ? { 'x-api-key': upstreamApiKey } : undefined
        });

        if (metricsResponse.status >= 300) {
            return res.status(502).json({
                success: false,
                error: 'Upstream metrics endpoint redirected (likely auth/login protected). Configure VPN_API_URL/VPN_METRICS_PATH/VPN_API_KEY.'
            });
        }

        const trafficData = metricsResponse.data || {};
        const bucket = trafficData.bytesTransferredByUserId || {};

        const rawBytes = bucket[userId] !== undefined ? bucket[userId] : 0;
        const numericBytes = Number(rawBytes);
        const safeBytes = Number.isFinite(numericBytes) ? numericBytes : 0;
        const usedGb = Number((safeBytes / (1024 * 1024 * 1024)).toFixed(2));

        return res.json({
            success: true,
            userId,
            used_gb: usedGb,
            message: 'Traffic data fetched successfully'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch traffic data'
        });
    }
});

module.exports = userApp;
