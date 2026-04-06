const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { generateFullBackupFile, getMMTString } = require('./backup');

let bot = null;
const pendingSessions = new Map();

function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '🔑 Key အသစ်ထုတ်မယ်' }],
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
    pendingSessions.clear();
    if (!token || !adminId) return;

    const Group = require('../models/Group');
    const User = require('../models/User');

    bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        pendingSessions.delete(adminId);
        bot.sendMessage(msg.chat.id,
            "👋 Welcome Admin!\n\n🔑 Key အသစ်ထုတ်မယ် — User Key အသစ်ထုတ်ရန်\n📦 Manual Backup — Backup ဖိုင်ယူရန်",
            getMainKeyboard()
        );
    });

    bot.onText(/\/cancel/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        pendingSessions.delete(adminId);
        bot.sendMessage(msg.chat.id, "❌ လုပ်ဆောင်ချက် ပယ်ဖျက်ပြီး။", getMainKeyboard());
    });

    bot.on('message', async (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        const text = (msg.text || '').trim();
        if (text.startsWith('/')) return;

        const session = pendingSessions.get(adminId);

        // ── Main menu buttons ──
        if (!session) {
            if (text === '📦 Manual Backup') {
                bot.sendMessage(msg.chat.id, "⏳ Backup ဖိုင် ထုတ်ယူနေပါသည်...");
                try {
                    const { filePath, filename } = await generateFullBackupFile();
                    await bot.sendDocument(msg.chat.id, filePath, {
                        caption: `📦 Manual System Backup\nFile: ${filename}\nTime: ${getMMTString()}`
                    });
                } catch (err) {
                    bot.sendMessage(msg.chat.id, "❌ Backup Error: " + err.message);
                }
                return;
            }

            if (text === '🔑 Key အသစ်ထုတ်မယ်') {
                try {
                    const groups = await Group.find({}, { name: 1, masterGroupId: 1 });
                    if (!groups || groups.length === 0) {
                        bot.sendMessage(msg.chat.id, "❌ Group တစ်ခုမှ မရှိသေးပါ။ Panel ထဲမှာ Group အရင်ဆောက်ပါ။");
                        return;
                    }
                    const buttons = groups.map((g) => [{ text: `📂 ${g.name}` }]);
                    buttons.push([{ text: '❌ Cancel' }]);
                    bot.sendMessage(msg.chat.id, "🔑 *Key ထုတ်မယ့် Group ရွေးပါ:*", {
                        parse_mode: 'Markdown',
                        reply_markup: { keyboard: buttons, resize_keyboard: true, one_time_keyboard: true }
                    });
                    pendingSessions.set(adminId, { step: 'select_group' });
                } catch (err) {
                    bot.sendMessage(msg.chat.id, "❌ Group list Error: " + err.message);
                }
                return;
            }
            return;
        }

        // ── Cancel at any step ──
        if (text === '❌ Cancel') {
            pendingSessions.delete(adminId);
            bot.sendMessage(msg.chat.id, "❌ ပယ်ဖျက်ပြီး။", getMainKeyboard());
            return;
        }

        // ── Step 1: Group selected ──
        if (session.step === 'select_group') {
            const groupName = text.replace(/^📂\s*/, '').trim();
            const group = await Group.findOne({ name: groupName });
            if (!group) {
                bot.sendMessage(msg.chat.id, `❌ "${groupName}" ဆိုတဲ့ Group မတွေ့ပါ။ ပြန်ရွေးပါ။`);
                return;
            }
            session.step = 'enter_username';
            session.groupName = group.name;
            session.masterGroupId = group.masterGroupId;
            session.masterIp = group.masterIp;
            session.masterApiKey = group.masterApiKey;
            session.nsRecord = group.nsRecord;
            pendingSessions.set(adminId, session);
            bot.sendMessage(msg.chat.id,
                `📂 Group: *${group.name}*\n\n👤 Username ရိုက်ထည့်ပါ:`,
                { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '❌ Cancel' }]], resize_keyboard: true } }
            );
            return;
        }

        // ── Step 2: Username entered ──
        if (session.step === 'enter_username') {
            const username = text.replace(/\s+/g, '_');
            if (username.length < 2) {
                bot.sendMessage(msg.chat.id, "❌ Username အနည်းဆုံး 2 လုံးရိုက်ပါ။");
                return;
            }
            const existing = await User.findOne({ name: username, groupName: session.groupName });
            if (existing) {
                bot.sendMessage(msg.chat.id, `❌ "${username}" ဆိုတဲ့ User ရှိပြီးသားပါ။ တခြားနာမည်ရိုက်ပါ။`);
                return;
            }
            session.step = 'enter_gb';
            session.userName = username;
            pendingSessions.set(adminId, session);
            bot.sendMessage(msg.chat.id,
                `👤 Username: *${username}*\n\n📊 Total GB ရိုက်ထည့်ပါ (ဥပမာ: 50):`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // ── Step 3: GB entered ──
        if (session.step === 'enter_gb') {
            const gb = Number(text);
            if (!gb || gb <= 0) {
                bot.sendMessage(msg.chat.id, "❌ GB ကို ဂဏန်းနဲ့ ရိုက်ပါ (ဥပမာ: 50)");
                return;
            }
            session.step = 'enter_expiry';
            session.totalGB = gb;
            pendingSessions.set(adminId, session);

            const d30 = new Date(); d30.setDate(d30.getDate() + 30);
            const defaultExpiry = d30.toISOString().split('T')[0];
            bot.sendMessage(msg.chat.id,
                `📊 GB: *${gb}*\n\n📅 သက်တမ်းကုန်ဆုံးမည့်ရက် ရိုက်ပါ (YYYY-MM-DD):\n(Enter နှိပ်ရင် default: ${defaultExpiry})`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [[{ text: defaultExpiry }], [{ text: '❌ Cancel' }]], resize_keyboard: true }
                }
            );
            return;
        }

        // ── Step 4: Expiry entered → Generate Key ──
        if (session.step === 'enter_expiry') {
            const expireDate = text;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(expireDate)) {
                bot.sendMessage(msg.chat.id, "❌ Format: YYYY-MM-DD (ဥပမာ: 2026-05-01)");
                return;
            }
            pendingSessions.delete(adminId);

            bot.sendMessage(msg.chat.id, `⏳ Key ထုတ်နေပါသည်...\n👤 ${session.userName}\n📂 ${session.groupName}\n📊 ${session.totalGB} GB\n📅 ${expireDate}`);

            try {
                const axios = require('axios');
                const Setting = require('../models/Setting');
                let apiKey = session.masterApiKey;
                if (!apiKey) {
                    const s = await Setting.findOne({}, { globalMasterApiKey: 1 });
                    apiKey = (s && s.globalMasterApiKey) || process.env.PANELMASTER_API_KEY || '';
                }

                const masterResponse = await axios.post(session.masterIp + '/api/generate-keys', {
                    masterGroupId: session.masterGroupId,
                    userName: session.userName,
                    totalGB: session.totalGB,
                    expireDate: expireDate
                }, { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 15000 });

                if (masterResponse.data && masterResponse.data.keys) {
                    const keys = masterResponse.data.keys;
                    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
                    const allChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    let userToken = letters.charAt(Math.floor(Math.random() * letters.length));
                    for (let i = 0; i < 31; i++) { userToken += allChars.charAt(Math.floor(Math.random() * allChars.length)); }

                    const defaultServer = Object.keys(keys)[0] || 'None';
                    const lastUser = await User.findOne({ groupName: session.groupName }).sort({ userNo: -1 });
                    const nextNo = (lastUser && lastUser.userNo) ? lastUser.userNo + 1 : 1;

                    await User.create({
                        name: session.userName,
                        token: userToken,
                        groupName: session.groupName,
                        totalGB: session.totalGB,
                        usedGB: 0,
                        currentServer: defaultServer,
                        expireDate: expireDate,
                        accessKeys: keys,
                        serverLabels: {},
                        userNo: nextNo
                    });

                    const nodeCount = Object.keys(keys).length;
                    const domainName = session.nsRecord || '';
                    const ssconfLink = domainName
                        ? `ssconf://${domainName}/${userToken}.json#QitoVPN_${session.userName}`
                        : '';
                    const panelLink = domainName
                        ? `https://${domainName}/panel/${userToken}`
                        : '';

                    let resultMsg = `✅ *Key ထုတ်ပြီးပါပြီ!*\n\n`;
                    resultMsg += `👤 Username: \`${session.userName}\`\n`;
                    resultMsg += `📂 Group: ${session.groupName}\n`;
                    resultMsg += `📊 Data: ${session.totalGB} GB\n`;
                    resultMsg += `📅 Expiry: ${expireDate}\n`;
                    resultMsg += `🌐 Nodes: ${nodeCount}\n`;
                    resultMsg += `🔑 Token: \`${userToken}\`\n`;
                    if (panelLink) resultMsg += `\n🌐 Panel: ${panelLink}`;
                    if (ssconfLink) resultMsg += `\n📱 SSCONF: \`${ssconfLink}\``;

                    bot.sendMessage(msg.chat.id, resultMsg, { parse_mode: 'Markdown', ...getMainKeyboard() });
                } else {
                    bot.sendMessage(msg.chat.id, "❌ Master Panel က keys return မလုပ်ပါ။", getMainKeyboard());
                }
            } catch (err) {
                const errMsg = (err.response && err.response.data && err.response.data.error)
                    ? err.response.data.error
                    : err.message;
                bot.sendMessage(msg.chat.id, `❌ Key ထုတ်ရာတွင် Error: ${errMsg}`, getMainKeyboard());
            }
            return;
        }
    });
}

// 🌟 Auto Time ပြည့်လျှင် ပို့မည့် Function 🌟
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
