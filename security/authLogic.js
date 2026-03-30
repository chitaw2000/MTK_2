const bcrypt = require('bcrypt');
const crypto = require('crypto');
const redisClient = require('../config/redis');
const { sendBackupDocument } = require('../utils/telegram'); // Reusing your telegram bot

// Password Hashing
async function hashPassword(plainPassword) {
    const saltRounds = 12;
    return await bcrypt.hash(plainPassword, saltRounds);
}

async function verifyPassword(plainPassword, hashedPassword) {
    return await bcrypt.compare(plainPassword, hashedPassword);
}

// Telegram 2FA OTP Generate & Send
async function generateAndSendOTP(adminChatId, botToken) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
    const challengeId = crypto.randomBytes(16).toString('hex');
    
    // Store in Redis (Server-side ONLY), expires in 5 minutes (300 secs)
    await redisClient.setEx(`otp:${challengeId}`, 300, otp);

    // Send via Telegram
    const axios = require('axios');
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: adminChatId,
        text: `🔐 Admin Login OTP: *${otp}*\n\n(Expires in 5 minutes. Do not share this with anyone.)`,
        parse_mode: 'Markdown'
    });

    return challengeId; // Client only gets this ID, not the OTP
}

async function verifyOTP(challengeId, userProvidedOtp) {
    const storedOtp = await redisClient.get(`otp:${challengeId}`);
    if (!storedOtp) return { valid: false, message: "OTP Expired or Invalid Challenge" };
    if (storedOtp === userProvidedOtp) {
        await redisClient.del(`otp:${challengeId}`); // Burn after reading
        return { valid: true };
    }
    return { valid: false, message: "Incorrect OTP" };
}

module.exports = { hashPassword, verifyPassword, generateAndSendOTP, verifyOTP };
