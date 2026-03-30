const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
    botToken: { type: String, default: '' },
    adminId: { type: String, default: '' },
    backupIntervalMinutes: { type: Number, default: 60 },
    // 🌟 Admin Login အတွက် အသစ်ထည့်ထားသော အပိုင်း 🌟
    adminUsername: { type: String, default: 'admin' },
    adminPasswordHash: { type: String, default: '' }
});

module.exports = mongoose.model('Setting', settingSchema);
