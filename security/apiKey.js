const crypto = require('crypto');
const Master = require('../models/Master');
const Group = require('../models/Group');
const Setting = require('../models/Setting');

function createApiKey() {
    const rawKey = 'pk_' + crypto.randomBytes(32).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    return { rawKey, hashedKey };
}

let _cachedGlobalKey = null;
let _cachedIncomingKey = null;
let _cachedAt = 0;

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

    if (providedKey === process.env.PANELMASTER_API_KEY) return next();

    if (!_cachedGlobalKey || Date.now() - _cachedAt > 60000) {
        try {
            const s = await Setting.findOne({}, { globalMasterApiKey: 1, incomingApiKey: 1 });
            _cachedGlobalKey = (s && s.globalMasterApiKey) || '';
            _cachedIncomingKey = (s && s.incomingApiKey) || '';
            _cachedAt = Date.now();
        } catch (e) {}
    }
    if (_cachedGlobalKey && providedKey === _cachedGlobalKey) return next();
    if (_cachedIncomingKey && providedKey === _cachedIncomingKey) return next();

    const validMaster = await Master.findOne({ apiKey: providedKey });
    const validGroup = await Group.findOne({ masterApiKey: providedKey });

    if (!validMaster && !validGroup) {
        console.error(`🚨 ALERT: Unauthorized API Access Attempt from IP: ${req.ip}`);
        return res.status(401).json({ success: false, error: "Invalid or Revoked API Key" });
    }

    next();
}

module.exports = { createApiKey, requireApiKey };
