const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
    botToken: { type: String, default: '' },
    adminId: { type: String, default: '' },
    backupIntervalMinutes: { type: Number, default: 60 },
    adminUsername: { type: String, default: 'admin' },
    adminPasswordHash: { type: String, default: '' },
    otpEnabled: { type: Boolean, default: false },
    globalMasterApiKey: { type: String, default: '' }
});

module.exports = mongoose.model('Setting', settingSchema);
