const session = require('express-session');
// 🌟 ဤနေရာတွင် Version အသစ်အတွက် Import ပုံစံ ပြောင်းလိုက်ပါသည် 🌟
const { RedisStore } = require('connect-redis'); 
const csrf = require('csurf');
const redisClient = require('../config/redis');

module.exports = function setupSessionAndCsrf(app, options = {}) {
    const sessionName = options.sessionName || 'qito_session_id';
    const csrfIgnorePaths = new Set(options.csrfIgnorePaths || []);
    const sessionSecret = process.env.SESSION_SECRET;

    if (!sessionSecret) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('SESSION_SECRET is required in production.');
        }
        console.warn('SESSION_SECRET is not set. Using a development fallback secret.');
    }

    // 1. Session Hardening
    app.use(session({
        store: new RedisStore({ client: redisClient }),
        secret: sessionSecret || 'dev-only-session-secret',
        resave: false,
        saveUninitialized: false,
        proxy: true,
        name: sessionName, // Use per-app session cookie name
        cookie: {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production', // HTTPS only in production
            sameSite: 'lax',
            maxAge: 30 * 60 * 1000 // 30 minutes idle timeout
        }
    }));

    // 2. Strict Origin/Referer Check Middleware for POST/PUT/DELETE
    app.use((req, res, next) => {
        if (req.method !== 'GET' && !req.path.startsWith('/api/')) { 
            const origin = req.headers.origin;
            const host = req.headers.host;
            if (origin && !origin.includes(host)) {
                return res.status(403).json({ error: "Cross-Origin Request Blocked" });
            }
        }
        next();
    });

    // 3. CSRF Protection (Except for API routes which use x-api-key)
    const csrfProtection = csrf({ cookie: false }); 
    app.use((req, res, next) => {
        const path = req.path || '';
        const isApiLikePath = path.startsWith('/api/') || path.includes('/api/');

        if (isApiLikePath || csrfIgnorePaths.has(path)) {
            next(); // Skip CSRF for API-style routes (including /admin/api/*).
        } else {
            csrfProtection(req, res, next);
        }
    });
};
