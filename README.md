## VPN Master System

Node.js app with 2 services:
- Admin dashboard (`/admin`) for managing groups, users, backups, Telegram OTP.
- User panel (`/panel/:token`) and subscription endpoint (`/:token.json`).

## Requirements

- Node.js 18+
- MongoDB running and reachable
- Redis running and reachable

## Setup

1) Install dependencies:

```bash
npm install
```

2) Create `.env` in project root:

```env
# Database
MONGO_URI=mongodb://127.0.0.1:27017/vpn_master_system

# Ports
ADMIN_PORT=4000
USER_PORT=3000

# Host/IP for generated links
VPS_IP=127.0.0.1

# Session and internal API auth
NODE_ENV=development
SESSION_SECRET=change-this-strong-secret
PANELMASTER_API_KEY=change-this-in-production

# Initial admin bootstrap (required for first login)
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=replace-with-strong-password
```

3) Run app:

```bash
npm start
```

## URLs

- Admin dashboard: `http://<VPS_IP>:<ADMIN_PORT>/admin`
- User panel: `http://<VPS_IP>:<USER_PORT>/panel/<token>`

## Notes

- `src/integrations/panelmaster` and `src/routes/panelmaster.routes.js` are helper modules and are not mounted by default in `server.js`.
- In production, `SESSION_SECRET` is required and the app fails fast if missing.
- `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` are used only for first-time admin bootstrap.
- Backups are generated under `backups/`.
