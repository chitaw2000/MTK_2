const mongoose = require('mongoose');

const masterSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        ip: { type: String, required: true, trim: true },
        apiKey: { type: String, required: true, trim: true }
    },
    { timestamps: true }
);

module.exports = mongoose.model('Master', masterSchema);
