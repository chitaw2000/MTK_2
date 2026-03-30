const rateLimit = require('express-rate-limit');

// 1. IP-level Login Rate Limit (5 mins block after 5 failed attempts)
const loginIpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5,
    message: { error: "Too many login attempts from this IP, please try again after 5 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

// 2. OTP Request Limiter (Wait 1 min between OTP requests)
const otpLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 1,
    message: { error: "Please wait 1 minute before requesting another OTP." }
});

// 3. API Bruteforce Protection
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: "Too many API requests, please try again later." }
});

module.exports = { loginIpLimiter, otpLimiter, apiLimiter };
