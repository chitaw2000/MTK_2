require('dotenv').config();
const express = require('express');
require('./config/db')();

const setupSecurityHeaders = require('./security/headers');
const setupSessionAndCsrf = require('./security/session');
const { apiLimiter } = require('./security/rateLimiter');
const { requireApiKey } = require('./security/apiKey');

const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');

const adminApp = express();
const userApp = express();

// Apply security headers to both active apps.
setupSecurityHeaders(adminApp);
setupSecurityHeaders(userApp);

// Admin dashboard needs session + CSRF protections.
setupSessionAndCsrf(adminApp, { sessionName: 'qito_admin_session_id' });
setupSessionAndCsrf(userApp, { sessionName: 'qito_user_session_id' });

adminApp.use(express.json());
adminApp.use(express.urlencoded({ extended: true }));
userApp.use(express.json());
userApp.use(express.urlencoded({ extended: true }));

// Apply API rate limiting to both apps.
adminApp.use('/api/', apiLimiter);
userApp.use('/api/', apiLimiter);

// Lock down all internal APIs with API key validation.
adminApp.use('/api/internal', requireApiKey);
userApp.use('/api/internal', requireApiKey);

adminApp.use('/admin', adminRoutes);
adminApp.use('/api/internal', adminRoutes);
userApp.use('/', userRoutes);

adminApp.use((err, req, res, next) => {
    if (err && err.code === 'EBADCSRFTOKEN') {
        return res.status(403).send('Invalid or expired CSRF token. Please refresh and try again.');
    }
    next(err);
});

userApp.use((err, req, res, next) => {
    if (err && err.code === 'EBADCSRFTOKEN') {
        return res.status(403).send('Invalid or expired request. Please refresh your panel and try again.');
    }
    next(err);
});

const ADMIN_PORT = process.env.ADMIN_PORT || 4000;
const USER_PORT = process.env.USER_PORT || 3000;
const VPS_IP = process.env.VPS_IP || '127.0.0.1';

adminApp.listen(ADMIN_PORT, () => console.log(`🚀 Admin Dashboard: http://${VPS_IP}:${ADMIN_PORT}/admin`));
userApp.listen(USER_PORT, () => console.log(`🚀 User Panel     : http://${VPS_IP}:${USER_PORT}/panel`));
