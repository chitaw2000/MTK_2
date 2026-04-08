const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: String,
    token: String,
    groupName: String,
    totalGB: Number,
    usedGB: Number,
    remainingGB: Number,
    isBlocked: { type: Boolean, default: false },
    currentServer: String,
    expireDate: String,
    accessKeys: Object,
    serverLabels: Object,
    userNo: Number,
    isActive: { type: Boolean, default: false },
    lastSyncNode: { type: String, default: '' },
    activeOnIps: { type: [String], default: [] },
    lastSyncAt: { type: Date, default: null }
});

module.exports = mongoose.model('User', userSchema);
