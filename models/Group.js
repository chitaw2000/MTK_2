const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    masterGroupId: { type: String, required: true },
    nsRecord: { type: String, required: true },
    masterIp: { type: String, required: true },
    masterApiKey: { type: String, required: true },
    masterName: { type: String, default: "1" }, // 🌟 API နံပါတ် မှတ်ရန် အသစ်
    panelLabel: { type: String, default: "Premium" },
    lastWebhookVersion: { type: String, default: '' },
    lastWebhookServerId: { type: String, default: '' },
    lastWebhookReceivedAt: { type: Date, default: null },
    lastWebhookEventAt: { type: String, default: '' }
});

module.exports = mongoose.model('Group', groupSchema);
