#!/bin/bash
set -e

# ─────────────────────────────────────────────────
# QITO VPN Panel - One-Line Installer
# Usage: bash <(curl -sL https://raw.githubusercontent.com/chitaw2000/MTK_2/main/install.sh)
# ─────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${CYAN}[→]${NC} $1"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     QITO VPN Panel - Auto Installer      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Check root ──
if [ "$EUID" -ne 0 ]; then
    err "Please run as root: sudo bash install.sh"
    exit 1
fi

# ── Detect OS ──
if ! command -v apt &>/dev/null; then
    err "This installer supports Ubuntu/Debian only."
    exit 1
fi

INSTALL_DIR="/root/MTK_2"
REPO_URL="https://github.com/chitaw2000/MTK_2.git"

# ── Prompt for required values ──
echo -e "${BOLD}── Configuration ──${NC}"
read -p "Admin Username [admin]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

while true; do
    read -sp "Admin Password (min 8 chars): " ADMIN_PASS
    echo ""
    if [ ${#ADMIN_PASS} -ge 8 ]; then break; fi
    warn "Password must be at least 8 characters."
done

read -p "Master API Key (pmk_xxx or leave blank): " MASTER_API_KEY
read -p "VPS Public IP [auto-detect]: " VPS_IP

if [ -z "$VPS_IP" ]; then
    VPS_IP=$(curl -s4 ifconfig.me 2>/dev/null || curl -s4 icanhazip.com 2>/dev/null || echo "127.0.0.1")
    info "Detected IP: $VPS_IP"
fi

SESSION_SECRET=$(openssl rand -hex 32)

echo ""
info "Starting installation..."
echo ""

# ══════════════════════════════════════════
# 1. System Updates & Dependencies
# ══════════════════════════════════════════
log "Updating system packages..."
apt update -y && apt upgrade -y

log "Installing essential packages..."
apt install -y curl wget git ufw fail2ban unattended-upgrades

# ══════════════════════════════════════════
# 2. Node.js 20 LTS
# ══════════════════════════════════════════
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
    log "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
else
    log "Node.js $(node -v) already installed."
fi

# ══════════════════════════════════════════
# 3. MongoDB (8.0 for Noble+, 7.0 for Jammy)
# ══════════════════════════════════════════
if ! command -v mongod &>/dev/null; then
    CODENAME=$(lsb_release -cs)
    case "$CODENAME" in
        noble|oracular|plucky)
            MONGO_VER="8.0"
            MONGO_CODENAME="noble"
            ;;
        jammy)
            MONGO_VER="7.0"
            MONGO_CODENAME="jammy"
            ;;
        focal)
            MONGO_VER="7.0"
            MONGO_CODENAME="focal"
            ;;
        *)
            MONGO_VER="8.0"
            MONGO_CODENAME="noble"
            warn "Unknown Ubuntu codename '$CODENAME', trying MongoDB ${MONGO_VER} with noble."
            ;;
    esac
    log "Installing MongoDB ${MONGO_VER} (${MONGO_CODENAME})..."
    curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_VER}.asc" | gpg --dearmor -o "/usr/share/keyrings/mongodb-server-${MONGO_VER}.gpg"
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-${MONGO_VER}.gpg ] https://repo.mongodb.org/apt/ubuntu ${MONGO_CODENAME}/mongodb-org/${MONGO_VER} multiverse" > "/etc/apt/sources.list.d/mongodb-org-${MONGO_VER}.list"
    apt update -y
    apt install -y mongodb-org
    systemctl enable mongod
    systemctl start mongod
else
    log "MongoDB already installed."
fi

# ══════════════════════════════════════════
# 4. Redis
# ══════════════════════════════════════════
if ! command -v redis-server &>/dev/null; then
    log "Installing Redis..."
    apt install -y redis-server
    systemctl enable redis-server
    systemctl start redis-server
else
    log "Redis already installed."
fi

# ══════════════════════════════════════════
# 5. PM2 (Process Manager)
# ══════════════════════════════════════════
if ! command -v pm2 &>/dev/null; then
    log "Installing PM2..."
    npm install -g pm2
    pm2 startup systemd -u root --hp /root 2>/dev/null || true
else
    log "PM2 already installed."
fi

# ══════════════════════════════════════════
# 6. Clone / Update Repository
# ══════════════════════════════════════════
if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    log "Cloning repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# ══════════════════════════════════════════
# 7. Install Node Dependencies
# ══════════════════════════════════════════
log "Installing Node.js dependencies..."
cd "$INSTALL_DIR"
npm install --production

# ══════════════════════════════════════════
# 8. Create .env
# ══════════════════════════════════════════
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    log "Creating .env configuration..."
    cat > "$ENV_FILE" <<ENVEOF
MONGO_URI=mongodb://127.0.0.1:27017/vpn_master_system
ADMIN_PORT=4000
USER_PORT=3000
VPS_IP=${VPS_IP}
NODE_ENV=production
SESSION_SECRET=${SESSION_SECRET}
PANELMASTER_API_KEY=${MASTER_API_KEY}
INITIAL_ADMIN_USERNAME=${ADMIN_USER}
INITIAL_ADMIN_PASSWORD=${ADMIN_PASS}
ENVEOF
    chmod 600 "$ENV_FILE"
else
    warn ".env already exists — skipping (edit manually if needed)."
fi

# ══════════════════════════════════════════
# 9. UFW Firewall
# ══════════════════════════════════════════
log "Configuring firewall (UFW)..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw allow 4000/tcp
echo "y" | ufw enable 2>/dev/null || true
log "Firewall active: SSH, HTTP, HTTPS, 3000, 4000 allowed."

# ══════════════════════════════════════════
# 10. Fail2Ban (Brute-force protection)
# ══════════════════════════════════════════
log "Configuring Fail2Ban..."
cat > /etc/fail2ban/jail.local <<'F2B'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ssh
filter  = sshd
logpath = /var/log/auth.log
maxretry = 3
F2B
systemctl enable fail2ban
systemctl restart fail2ban

# ══════════════════════════════════════════
# 11. Auto Security Updates
# ══════════════════════════════════════════
log "Enabling automatic security updates..."
dpkg-reconfigure -plow unattended-upgrades 2>/dev/null || true

# ══════════════════════════════════════════
# 12. SSH Hardening
# ══════════════════════════════════════════
log "Hardening SSH..."
SSHD_CONF="/etc/ssh/sshd_config"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONF"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONF"
sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' "$SSHD_CONF"
systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true
warn "SSH: root password login disabled. Make sure you have SSH key access!"

# ══════════════════════════════════════════
# 13. Start Application
# ══════════════════════════════════════════
log "Starting application with PM2..."
cd "$INSTALL_DIR"
pm2 delete vpn-master 2>/dev/null || true
pm2 start server.js --name vpn-master
pm2 save

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           Installation Complete!                     ║${NC}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "║                                                      ║"
echo -e "║  ${GREEN}Admin Panel:${NC}  http://${VPS_IP}:4000/admin            "
echo -e "║  ${GREEN}User Panel:${NC}   http://${VPS_IP}:3000/panel            "
echo -e "║                                                      "
echo -e "║  ${CYAN}Admin User:${NC}   ${ADMIN_USER}                          "
echo -e "║  ${CYAN}Admin Pass:${NC}   (as entered)                          "
echo -e "║                                                      "
echo -e "║  ${YELLOW}Next Steps:${NC}                                        "
echo -e "║  1. Set up Nginx reverse proxy + SSL (see below)      "
echo -e "║  2. Go to Settings > save Telegram bot for backups    "
echo -e "║  3. Enable OTP toggle for 2FA login security          "
echo -e "║  4. Add Master API key in Settings if not set         "
echo -e "║                                                      "
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}── Nginx + SSL Setup (run after DNS is pointed) ──${NC}"
echo ""
echo '  apt install -y nginx certbot python3-certbot-nginx'
echo '  # Create /etc/nginx/sites-available/vpn-panel with:'
echo '  #   server { server_name your-domain.com;'
echo '  #     location /admin { proxy_pass http://127.0.0.1:4000; }'
echo '  #     location / { proxy_pass http://127.0.0.1:3000; }'
echo '  #   }'
echo '  ln -s /etc/nginx/sites-available/vpn-panel /etc/nginx/sites-enabled/'
echo '  nginx -t && systemctl reload nginx'
echo '  certbot --nginx -d your-domain.com'
echo ""
echo -e "${GREEN}Done! Panel is running.${NC}"
