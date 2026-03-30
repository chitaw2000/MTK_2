const crypto = require('crypto');
const Master = require('../models/Master');
const Group = require('../models/Group');

// Generate a secure API Key and its Hash
function createApiKey() {
    const rawKey = 'pk_' + crypto.randomBytes(32).toString('hex'); // eg. pk_1a2b...
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    return { rawKey, hashedKey };
}

// Middleware to validate API Keys dynamically from DB
async function requireApiKey(req, res, next) {
    const headerKey = req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];
    const queryKey = req.query && (req.query.apiKey || req.query.api_key || req.query.key);
    const bodyKey = req.body && (req.body.apiKey || req.body.api_key || req.body.key || req.body.masterApiKey);
    let providedKey = String(headerKey || '').trim();

    if (!providedKey && authHeader) {
        const authValue = String(authHeader).trim();
        providedKey = authValue.toLowerCase().startsWith('bearer ')
            ? authValue.slice(7).trim()
            : authValue;
    }
    if (!providedKey && queryKey) providedKey = String(queryKey).trim();
    if (!providedKey && bodyKey) providedKey = String(bodyKey).trim();
    
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
    
    const validMaster = await Master.findOne({ apiKey: providedKey });
    const validGroup = await Group.findOne({ masterApiKey: providedKey });

    if (!validMaster && !validGroup) {
        // Audit Log here
        console.error(`🚨 ALERT: Unauthorized API Access Attempt from IP: ${req.ip}`);
        return res.status(401).json({ success: false, error: "Invalid or Revoked API Key" });
    }

    next();
}

module.exports = { createApiKey, requireApiKey };
