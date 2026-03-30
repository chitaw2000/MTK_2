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

userApp.get('/panel/api/ping/:token/:nodeName', async (req, res) => {
    try {
        const { token, nodeName } = req.params;
        const user = await User.findOne({ token: token });
        if (!user) return res.json({ status: 'offline' });
        const group = await Group.findOne({ name: user.groupName });
        if (!group || !group.masterIp) return res.json({ status: 'offline' });

        const apiKeyHeader = group.masterApiKey || process.env.PANELMASTER_API_KEY;
        const url = `${group.masterIp}/api/ping/${encodeURIComponent(nodeName)}`;
        const response = await axios.get(url, { headers: { 'x-api-key': apiKeyHeader }, timeout: 4000 });
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

        const group = await Group.findOne({ name: user.groupName });
        const domainName = (group && group.nsRecord) ? group.nsRecord : req.hostname;

        const today = new Date(); today.setHours(0, 0, 0, 0); 
        const expDate = new Date(user.expireDate);
        const isExpired = user.usedGB >= user.totalGB || today > expDate;

        const encodedName = encodeURIComponent(user.name.replace(/\s+/g, ''));
        const ssconfLink = `ssconf://${domainName}/${token}.json#QitoVPN_${encodedName}`; 

        let nodesListHtml = '';
        let nodeNames = []; 
        
        if (user.accessKeys && Object.keys(user.accessKeys).length > 0) {
            Object.keys(user.accessKeys).forEach(serverName => {
                nodeNames.push(serverName);
                const isSelected = user.currentServer === serverName;
                const safeNodeId = serverName.replace(/\s+/g, '-');
                
                const activeClass = isSelected ? 'bg-indigo-900/30 border-l-4 border-indigo-500' : 'hover:bg-slate-800/50';
                const iconColor = isSelected ? 'text-indigo-400' : 'text-slate-400';
                const checkIcon = isSelected ? `<i class="fas fa-check-circle text-indigo-500 text-lg"></i>` : `<i class="fas fa-arrow-circle-right text-slate-600 hover:text-slate-400 transition text-lg"></i>`;

                nodesListHtml += `
                <form id="form-${safeNodeId}" action="/panel/change-server" method="POST" class="m-0 border-b border-slate-800 last:border-0">
                    <input type="hidden" name="token" value="${token}">
                    <input type="hidden" name="newServer" value="${serverName}">
                    <button type="button" onclick="confirmSwitch('form-${safeNodeId}', '${serverName}')" class="w-full flex justify-between items-center p-4 transition-all duration-200 ${activeClass}">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700"><i class="fas fa-globe ${iconColor} text-sm"></i></div>
                            <span class="font-bold ${isSelected ? 'text-white' : 'text-slate-300'} text-[15px] tracking-wide">${serverName}</span>
                        </div>
                        <div class="flex items-center gap-4">
                            <span id="ping-${safeNodeId}" class="text-xs font-semibold text-slate-500 w-16 text-right tracking-wider"><i class="fas fa-circle-notch fa-spin text-slate-600"></i></span>
                            ${checkIcon}
                        </div>
                    </button>
                </form>`;
            });
        } else { nodesListHtml = `<div class="p-6 text-center text-slate-500 font-medium">No Servers Available</div>`; }

        const usagePercent = user.totalGB > 0 ? ((user.usedGB / user.totalGB) * 100).toFixed(1) : 0;
        const progressColor = isExpired ? 'from-red-600 to-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)]' : 'from-indigo-600 via-indigo-500 to-purple-500 shadow-[0_0_15px_rgba(99,102,241,0.6)]';
        const logoUrl = "https://i.postimg.cc/G2FPpD7C/QUITO-profile-1.png"; 
        const outlineIconUrl = "https://i.postimg.cc/rm7q3wKz/images-(23).jpg";

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
                            <span class="text-[11px] font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-400 uppercase tracking-widest">Premium</span>
                        </div>
                    </div>

                    <div class="mb-5 ml-1">
                        <p class="text-sm font-bold text-slate-400">Username: <span class="text-[22px] font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-200 via-yellow-400 to-amber-500 drop-shadow-[0_0_12px_rgba(250,204,21,0.6)] tracking-wide ml-1 uppercase">${user.name}</span></p>
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
                            <img src="${outlineIconUrl}" class="w-6 h-6 rounded object-cover shadow-sm"><span class="tracking-wide text-[15px]">Connect with Outline</span>
                        </a>
                    </div>
                    <button id="copyBtn" onclick="copyLink('${ssconfLink}')" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-2xl shadow-[0_6px_20px_rgba(79,70,229,0.35)] mb-8 transition-all active:scale-[0.98] flex justify-center items-center gap-2.5 uppercase tracking-wider text-sm">
                        <i class="fas fa-copy text-lg"></i> Copy Subscription Link
                    </button>

                    <h3 class="text-xs font-black text-slate-500 uppercase tracking-[0.2em] mb-4 ml-2">Available Servers</h3>
                    <div class="bg-[#151f32] rounded-3xl overflow-hidden shadow-xl border border-slate-800">
                        <div class="bg-slate-800/30 p-4 text-[13px] font-bold text-slate-300 border-b border-slate-800 flex items-center gap-2"><i class="fas fa-network-wired text-indigo-500"></i> Node Group: ${user.groupName}</div>
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
                    const nodes = ${JSON.stringify(nodeNames)}; const token = '${token}'; let currentFormId = '';
                    window.onload = function() {
                        const urlParams = new URLSearchParams(window.location.search);
                        if (urlParams.get('switched') === 'true') {
                            const sm = document.getElementById('successModal'); const sc = document.getElementById('successModalContent');
                            sm.classList.remove('hidden'); sm.classList.add('flex');
                            setTimeout(() => { sm.classList.remove('opacity-0'); sc.classList.remove('scale-95'); }, 10);
                            window.history.replaceState({}, document.title, window.location.pathname);
                        }
                    };
                    function closeSuccessModal() {
                        const sm = document.getElementById('successModal'); const sc = document.getElementById('successModalContent');
                        sm.classList.add('opacity-0'); sc.classList.add('scale-95');
                        setTimeout(() => { sm.classList.add('hidden'); sm.classList.remove('flex'); }, 300);
                    }
                    function confirmSwitch(formId, serverName) {
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
                        for(let node of nodes) {
                            try {
                                let res = await fetch('/panel/api/ping/' + token + '/' + encodeURIComponent(node));
                                let data = await res.json();
                                let safeNodeId = node.replace(/\\s+/g, '-'); let pingEl = document.getElementById('ping-' + safeNodeId);
                                if(pingEl && data.status === 'online' && data.latency_ms) {
                                    let latency = Math.round(data.latency_ms); let color = latency < 100 ? 'text-green-400' : (latency < 200 ? 'text-yellow-400' : 'text-red-400');
                                    pingEl.innerHTML = \`<span class="\${color} font-bold drop-shadow-[0_0_5px_rgba(0,0,0,0.5)]"><i class="fas fa-signal text-[10px] mr-1"></i>\${latency} ms</span>\`;
                                } else if (pingEl) { pingEl.innerHTML = '<span class="text-slate-600 font-bold text-[11px] uppercase">Offline</span>'; }
                            } catch(e) {
                                let safeNodeId = node.replace(/\\s+/g, '-'); let pingEl = document.getElementById('ping-' + safeNodeId);
                                if (pingEl) pingEl.innerHTML = '<span class="text-slate-700 text-[11px]">Error</span>';
                            }
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
        
        const today = new Date(); today.setHours(0, 0, 0, 0); 
        const expDate = new Date(user.expireDate);
        if (user.usedGB >= user.totalGB || today > expDate) {
            return res.status(403).send("Account Expired. You cannot change server.");
        }
        
        const groupInfo = await Group.findOne({ name: user.groupName });
        if (!groupInfo) return res.status(404).send("Group Error");

        const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;

        if (!user.accessKeys || !user.accessKeys[newServer]) {
            try {
                const masterResponse = await fetchWithRetry(groupInfo.masterIp + '/api/generate-keys', {
                    masterGroupId: groupInfo.masterGroupId, userName: user.name, totalGB: user.totalGB, expireDate: user.expireDate
                }, { headers: { 'x-api-key': apiKeyHeader } });
                
                if (masterResponse.data && masterResponse.data.keys) { 
                    const updateQuery = {};
                    for (const [nodeName, nodeConfig] of Object.entries(masterResponse.data.keys)) {
                        updateQuery[`accessKeys.${nodeName}`] = nodeConfig;
                    }
                    await User.updateOne({ _id: user._id }, { $set: updateQuery });
                }
            } catch (err) {}
        }
        user.currentServer = newServer; await user.save(); 
        try { await redisClient.del(token); } catch(e){}
        try { await fetchWithRetry(groupInfo.masterIp + '/api/webhook/switch', { token: token, activeServer: newServer }, { headers: { 'x-api-key': apiKeyHeader } }); } catch (err) {}
        
        res.redirect('/panel/' + token + '?switched=true');
    } catch (error) { res.status(500).send("Error Changing Server"); }
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

        // 🌟 200 OK + Outline Native Error JSON
        if (isExpired) {
            const errorJson = {
                "error": {
                    "message": "⛔️ ဝယ်ယူထားသော Package မှာကုန်ဆုံးသွားပြီဖြစ်ပါတယ်။ Admin ထံ ဆက်သွယ်ပြီး Package အသစ်ဝယ်ယူနိုင်ပါတယ်။",
                    "details": "Package ဝယ်ယူရန် http://t.me/qitoadmin သို့မဟုတ် http://m.me/qitotechmm ကိုဆက်သွယ်နိုင်ပါတယ်။\n\nQITO Tech Premium VPN မှ အကောင်းဆုံး ဝန်ဆောင်မှုများ ဆက်လက်ပေးရန် အဆင်သင့်ရှိနေပါသည်။"
                }
            };
            try {
                const groupInfo = await Group.findOne({ name: user.groupName });
                if (groupInfo && groupInfo.masterIp) {
                    const apiKeyHeader = groupInfo.masterApiKey || process.env.PANELMASTER_API_KEY;
                    axios.post(groupInfo.masterIp + '/api/internal/block-user', { username: user.name }, { headers: { 'x-api-key': apiKeyHeader }, timeout: 2000 }).catch(() => {});
                }
            } catch (e) {}

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.status(200).send(JSON.stringify(errorJson)); 
        }

        const cachedKey = await redisClient.get(token);
        if (cachedKey) { 
            try { return res.json(JSON.parse(cachedKey)); } catch (e) { await redisClient.del(token); } 
        }

        if (user.accessKeys && user.accessKeys[user.currentServer]) {
            let rawConfig = user.accessKeys[user.currentServer];
            if (typeof rawConfig === 'string' && rawConfig.startsWith('{')) { try { rawConfig = JSON.parse(rawConfig); } catch(e){} }
            if (typeof rawConfig === 'string' && rawConfig.startsWith('ss://')) { return res.json({ server: rawConfig }); }

            if (typeof rawConfig === 'object' && rawConfig.server) { 
                rawConfig = { 
                    server: rawConfig.server, 
                    server_port: Number(rawConfig.server_port), 
                    password: rawConfig.password, 
                    method: rawConfig.method
                }; 
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

        if (!token && !name) {
            throw makeBadRequest('Invalid payload: token or name is required');
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

        if (isBlockedRaw !== undefined && !['true', 'false', '1', '0'].includes(String(isBlockedRaw).toLowerCase())) {
            throw makeBadRequest('Invalid isBlocked: boolean value required');
        }

        if (expireDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(expireDate))) {
            throw makeBadRequest('Invalid expireDate: expected YYYY-MM-DD');
        }

        if (usedGb !== undefined) user.usedGB = usedGb;
        if (totalGb !== undefined) user.totalGB = totalGb;
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
        const apiKey = req.headers['x-api-key'];
        const { masterGroupId, newServerName, userKeys } = req.body;
        if (!newServerName || !userKeys) return res.status(400).json({ error: "Invalid payload data" });

        const validGroup = await Group.findOne({ masterGroupId: masterGroupId });
        // 🌟 Ensure it checks process.env if Group key doesn't match
        if (!validGroup && apiKey !== process.env.PANELMASTER_API_KEY) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        let successCount = 0;
        for (const [identifier, newConfig] of Object.entries(userKeys)) {
            const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const user = await User.findOne({ $or: [{ token: identifier }, { name: new RegExp('^' + escapedIdentifier + '$', 'i') }] });

            if (user) {
                await User.updateOne({ _id: user._id }, { $set: { [`accessKeys.${newServerName}`]: newConfig } });
                try { await redisClient.del(user.token); } catch(e){}
                successCount++;
            }
        }
        return res.json({ success: true, message: `Server synced successfully for ${successCount} users` });
    } catch (error) { res.status(500).json({ error: "Server Error" }); }
}

userApp.post('/api/internal/sync-new-server', syncNewServerHandler);
userApp.post('/sync-new-server', syncNewServerHandler);
userApp.post('/admin/api/internal/sync-new-server', requireApiKey, syncNewServerHandler);

module.exports = userApp;
