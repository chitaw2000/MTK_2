const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
    groupName: { type: String, required: true }, // ဥပမာ - ⭐ VIP Asia
    serverName: { type: String, required: true }, // ဥပမာ - SG-VIP-1
    serverKey: { type: String, required: true }   // ss://...
});

module.exports = mongoose.model('Server', serverSchema);
