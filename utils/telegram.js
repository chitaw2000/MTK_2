const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { generateFullBackupFile, getMMTString } = require('./backup');

let bot = null;
const activeGroup = new Map();

function getMainKeyboard(adminId) {
    const g = activeGroup.get(adminId);
    const groupLabel = g ? g.groupName : 'မရွေးရသေး';
    return {
        reply_markup: {
            keyboard: [
                [{ text: '🔑 New Key' }, { text: `📂 Change Group (${groupLabel})` }],
                [{ text: '📦 Manual Backup' }]
            ],
            resize_keyboard: true,
            persistent: true
        }
    };
}

function initTelegramBot(token, adminId) {
    if (bot) {
        bot.stopPolling();
        bot = null;
    }
    if (!token || !adminId) return;

    const Group = require('../models/Group');
    const User = require('../models/User');

    bot = new TelegramBot(token, { polling: true });

    let selectingGroup = false;

    bot.onText(/\/start/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        selectingGroup = false;
        const g = activeGroup.get(adminId);
        let welcome = '👋 Welcome Admin!\n\n';
        if (g) {
            welcome += `📂 Active Group: *${g.groupName}*\n\n`;
        } else {
            welcome += '⚠️ Group မရွေးရသေးပါ။ Change Group နှိပ်ပြီးရွေးပါ။\n\n';
        }
        welcome += '🔑 New Key — `username days` ရိုက်ပြီး Key ထုတ်ရန်\n';
        welcome += '📂 Change Group — Group ပြောင်းရန်\n';
        welcome += '📦 Manual Backup — Backup ယူရန်';
        bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown', ...getMainKeyboard(adminId) });
    });

    bot.onText(/\/cancel/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        selectingGroup = false;
        bot.sendMessage(msg.chat.id, "❌ ပယ်ဖျက်ပြီး။", getMainKeyboard(adminId));
    });

    bot.on('message', async (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        const text = (msg.text || '').trim();
        if (text.startsWith('/')) return;

        // ── Change Group button ──
        if (text.startsWith('📂 Change Group')) {
            try {
                const groups = await Group.find({}, { name: 1, keyLabel: 1, defaultGB: 1, masterGroupId: 1, masterIp: 1, masterApiKey: 1, nsRecord: 1 });
                if (!groups || groups.length === 0) {
                    bot.sendMessage(msg.chat.id, "❌ Group တစ်ခုမှ မရှိသေးပါ။");
                    return;
                }
                const buttons = groups.map((g) => [{ text: `📂 ${g.name}` }]);
                buttons.push([{ text: '❌ Cancel' }]);
                selectingGroup = true;
                bot.sendMessage(msg.chat.id, "📂 *Group ရွေးပါ:*", {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: buttons, resize_keyboard: true, one_time_keyboard: true }
                });
            } catch (err) {
                bot.sendMessage(msg.chat.id, "❌ Error: " + err.message);
            }
            return;
        }

        // ── Group selection response ──
        if (selectingGroup) {
            if (text === '❌ Cancel') {
                selectingGroup = false;
                bot.sendMessage(msg.chat.id, "❌ ပယ်ဖျက်ပြီး။", getMainKeyboard(adminId));
                return;
            }
            const groupName = text.replace(/^📂\s*/, '').trim();
            const group = await Group.findOne({ name: groupName });
            if (!group) {
                bot.sendMessage(msg.chat.id, `❌ "${groupName}" Group မတွေ့ပါ။ ပြန်ရွေးပါ။`);
                return;
            }
            activeGroup.set(adminId, {
                groupName: group.name,
                masterGroupId: group.masterGroupId,
                masterIp: group.masterIp,
                masterApiKey: group.masterApiKey,
                nsRecord: group.nsRecord,
                keyLabel: group.keyLabel || group.name,
                defaultGB: group.defaultGB || 50
            });
            selectingGroup = false;
            bot.sendMessage(msg.chat.id,
                `✅ Active Group: *${group.name}*\nDefault GB: ${group.defaultGB || 50}\nKey Label: ${group.keyLabel || group.name}\n\n🔑 Key ထုတ်ရန် \`username days\` ရိုက်ပါ\nဥပမာ: \`mtk 30\``,
                { parse_mode: 'Markdown', ...getMainKeyboard(adminId) }
            );
            return;
        }

        // ── Manual Backup ──
        if (text === '📦 Manual Backup') {
            bot.sendMessage(msg.chat.id, "⏳ Backup ထုတ်နေပါသည်...");
            try {
                const { filePath, filename } = await generateFullBackupFile();
                await bot.sendDocument(msg.chat.id, filePath, {
                    caption: `📦 Manual Backup\nFile: ${filename}\nTime: ${getMMTString()}`
                });
            } catch (err) {
                bot.sendMessage(msg.chat.id, "❌ Backup Error: " + err.message);
            }
            return;
        }

        // ── New Key button (show instructions) ──
        if (text === '🔑 New Key') {
            const g = activeGroup.get(adminId);
            if (!g) {
                bot.sendMessage(msg.chat.id, "⚠️ Group မရွေးရသေးပါ။ 📂 Change Group နှိပ်ပြီးရွေးပါ။", getMainKeyboard(adminId));
                return;
            }
            bot.sendMessage(msg.chat.id,
                `📂 Group: *${g.groupName}*\n📊 Default: ${g.defaultGB} GB\n\n✏️ \`username days\` ရိုက်ပါ\nGB ထည့်ချင်ရင် \`username days gb\`\n\nExample:\n\`mtk 30\` → mtk, 30 ရက်, ${g.defaultGB}GB\n\`mtk 30 100\` → mtk, 30 ရက်, 100GB`,
                { parse_mode: 'Markdown', ...getMainKeyboard(adminId) }
            );
            return;
        }

        // ── Key generation: "username days" or "username days gb" ──
        const g = activeGroup.get(adminId);
        if (!g) return;

        const parts = text.split(/\s+/);
        if (parts.length < 2) return;

        const rawName = parts[0];
        const days = parseInt(parts[1], 10);
        if (!rawName || isNaN(days) || days <= 0) return;

        const totalGB = (parts.length >= 3 && Number(parts[2]) > 0) ? Number(parts[2]) : g.defaultGB;
        const username = rawName.replace(/\s+/g, '_');

        if (username.length < 2) {
            bot.sendMessage(msg.chat.id, "❌ Username အနည်းဆုံး 2 လုံးရိုက်ပါ။");
            return;
        }

        const existing = await User.findOne({ name: username, groupName: g.groupName });
        if (existing) {
            bot.sendMessage(msg.chat.id, `❌ "${username}" ရှိပြီးသားပါ ${g.groupName} ထဲမှာ။ တခြားနာမည်သုံးပါ။`);
            return;
        }

        const expDate = new Date();
        expDate.setDate(expDate.getDate() + days);
        const expireDate = expDate.toISOString().split('T')[0];

        bot.sendMessage(msg.chat.id, `⏳ Key ထုတ်နေပါသည်...\n👤 ${username} | 📊 ${totalGB}GB | 📅 ${days} ရက် (${expireDate})\n📂 ${g.groupName}`);

        try {
            const axios = require('axios');
            const Setting = require('../models/Setting');
            let apiKey = g.masterApiKey;
            if (!apiKey) {
                const s = await Setting.findOne({}, { globalMasterApiKey: 1 });
                apiKey = (s && s.globalMasterApiKey) || process.env.PANELMASTER_API_KEY || '';
            }

            const masterResponse = await axios.post(g.masterIp + '/api/generate-keys', {
                masterGroupId: g.masterGroupId,
                userName: username,
                totalGB: totalGB,
                expireDate: expireDate
            }, { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 15000 });

            if (masterResponse.data && masterResponse.data.keys) {
                const keys = masterResponse.data.keys;
                const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
                const allChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                let userToken = letters.charAt(Math.floor(Math.random() * letters.length));
                for (let i = 0; i < 31; i++) { userToken += allChars.charAt(Math.floor(Math.random() * allChars.length)); }

                const defaultServer = Object.keys(keys)[0] || 'None';
                const lastUser = await User.findOne({ groupName: g.groupName }).sort({ userNo: -1 });
                const nextNo = (lastUser && lastUser.userNo) ? lastUser.userNo + 1 : 1;

                await User.create({
                    name: username, token: userToken, groupName: g.groupName,
                    totalGB: totalGB, usedGB: 0, currentServer: defaultServer,
                    expireDate: expireDate, accessKeys: keys, serverLabels: {}, userNo: nextNo
                });

                const nodeCount = Object.keys(keys).length;
                const domainName = g.nsRecord || '';
                const label = g.keyLabel || g.groupName;
                const ssconfLink = domainName
                    ? `ssconf://${domainName}/${userToken}.json#${encodeURIComponent(label)}_${encodeURIComponent(username)}`
                    : '';
                const panelLink = domainName ? `https://${domainName}/panel/${userToken}` : '';

                let resultMsg = `✅ *Key ထုတ်ပြီးပါပြီ!*\n\n`;
                resultMsg += `👤 Username: \`${username}\`\n`;
                resultMsg += `📂 Group: ${g.groupName}\n`;
                resultMsg += `📊 Data: ${totalGB} GB\n`;
                resultMsg += `📅 Expiry: ${expireDate} (${days} days)\n`;
                resultMsg += `🌐 Nodes: ${nodeCount}\n`;
                resultMsg += `🔑 Token: \`${userToken}\`\n`;
                if (panelLink) resultMsg += `\n🌐 Panel: ${panelLink}`;
                if (ssconfLink) resultMsg += `\n📱 SSCONF: \`${ssconfLink}\``;

                bot.sendMessage(msg.chat.id, resultMsg, { parse_mode: 'Markdown', ...getMainKeyboard(adminId) });
            } else {
                bot.sendMessage(msg.chat.id, "❌ Master Panel က keys return မလုပ်ပါ။", getMainKeyboard(adminId));
            }
        } catch (err) {
            const errMsg = (err.response && err.response.data && err.response.data.error)
                ? err.response.data.error
                : err.message;
            bot.sendMessage(msg.chat.id, `❌ Key Error: ${errMsg}`, getMainKeyboard(adminId));
        }
    });
}

async function sendAutoBackupDocument(adminId) {
    if (!bot || !adminId) return;
    try {
        const { filePath, filename } = await generateFullBackupFile();
        await bot.sendDocument(adminId, filePath, {
            caption: `🕒 Auto System Backup\nFile: ${filename}\nTime: ${getMMTString()}`
        });
    } catch (error) {
        console.error("❌ Auto Backup Send Error:", error.message);
    }
}

async function sendBackupDocument(token, adminId, filePath, caption) {
    if (!token || !adminId || !filePath) return;
    const tempBot = new TelegramBot(token, { polling: false });
    await tempBot.sendDocument(adminId, filePath, { caption: caption || 'Backup file' });
}

module.exports = { initTelegramBot, sendAutoBackupDocument, sendBackupDocument };
