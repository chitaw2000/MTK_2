const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { generateFullBackupFile, getMMTString } = require('./backup');

let bot = null;

function initTelegramBot(token, adminId) {
    // အကယ်၍ Bot run နေပြီးသားဖြစ်လျှင် အရင်ရပ်ပါမည်
    if (bot) {
        bot.stopPolling();
        bot = null;
    }
    if (!token || !adminId) return;

    // Bot ကို အသစ်ပြန်စပါမည်
    bot = new TelegramBot(token, { polling: true });

    // 🌟 /start နှိပ်လျှင် Keyboard ခလုတ်ပေါ်စေရန် 🌟
    bot.onText(/\/start/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        const opts = {
            reply_markup: {
                keyboard: [[{ text: '📦 Manual Backup' }]],
                resize_keyboard: true,
                persistent: true
            }
        };
        bot.sendMessage(msg.chat.id, "👋 Welcome Admin! Auto-backup is running.\nအောက်ပါခလုတ်ကို နှိပ်၍လည်း Backup ကို အချိန်မရွေး ယူနိုင်ပါသည်။", opts);
    });

    // 🌟 Manual Backup ခလုတ် နှိပ်သောအခါ 🌟
    bot.on('message', async (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        
        if (msg.text === '📦 Manual Backup') {
            bot.sendMessage(msg.chat.id, "⏳ Backup ဖိုင် ထုတ်ယူနေပါသည်... ခေတ္တစောင့်ပါ။");
            try {
                const { filePath, filename } = await generateFullBackupFile();
                await bot.sendDocument(msg.chat.id, filePath, {
                    caption: `📦 Manual System Backup\nFile: ${filename}\nTime: ${getMMTString()}`
                });
            } catch (err) {
                bot.sendMessage(msg.chat.id, "❌ Backup ထုတ်ယူရာတွင် အခက်အခဲရှိနေပါသည်: " + err.message);
            }
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
