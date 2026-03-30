const helmet = require('helmet');

module.exports = function setupSecurityHeaders(app) {
    // Trust Cloudflare / Nginx Reverse Proxy
    app.set('trust proxy', 1);

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                imgSrc: ["'self'", "data:", "https://i.postimg.cc"],
                connectSrc: ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));

    // Security Headers
    app.use(helmet.frameguard({ action: 'deny' })); // X-Frame-Options: DENY
    app.use(helmet.noSniff()); // X-Content-Type-Options: nosniff
    app.use(helmet.referrerPolicy({ policy: 'strict-origin-when-cross-origin' }));
    app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true })); // HSTS
};
