const crypto = require('crypto');
const Master = require('../models/Master');

// Generate a secure API Key and its Hash
function createApiKey() {
    const rawKey = 'pk_' + crypto.randomBytes(32).toString('hex'); // eg. pk_1a2b...
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    return { rawKey, hashedKey };
}

// Middleware to validate API Keys dynamically from DB
async function requireApiKey(req, res, next) {
    const providedKey = req.headers['x-api-key'];
    
    if (!providedKey) {
        return res.status(401).json({ success: false, error: "API Key Missing" });
    }

    // 1. Check against Environment Variable (Master Secret)
    if (providedKey === process.env.PANELMASTER_API_KEY) {
        return next();
    }

    // 2. Check against Per-Client DB Keys
    const hashedProvided = crypto.createHash('sha256').update(providedKey).digest('hex');
    
    // Assume you have an ApiKey model (You will need to create this Mongoose model)
    // const validKeyRecord = await ApiKey.findOne({ hashedKey: hashedProvided, status: 'active' });
    
    const validMaster = await Master.findOne({ apiKey: providedKey }); // Or Hash check based on your DB setup

    if (!validMaster) {
        // Audit Log here
        console.error(`🚨 ALERT: Unauthorized API Access Attempt with invalid key from IP: ${req.ip}`);
        return res.status(401).json({ success: false, error: "Invalid or Revoked API Key" });
    }

    next();
}

module.exports = { createApiKey, requireApiKey };
