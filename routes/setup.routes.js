const { Router } = require('express');
const serverModel = require('../models/server.model');
const serverService = require('../services/server.service');
const { logger } = require('../utils/logger');

const router = Router();

/**
 * GET /setup/:token.sh or /setup/:token
 * Generates and returns a personalized 1-liner bash installation script.
 * Never requires authentication because the unique random setup token authorizes installation.
 */
router.get('/:token', async (req, res) => {
  const rawToken = req.params.token || '';
  // Strip .sh extension if present in URL
  const token = rawToken.replace(/\.sh$/i, '');

  try {
    const server = await serverModel.findBySetupToken(token);
    if (!server) {
      res.status(404).set('Content-Type', 'text/plain').send(
        '#!/bin/bash\necho "PortalOps Error: Setup token not found or already expired." >&2\nexit 1\n'
      );
      return;
    }

    const host = req.get('host') || 'portalops.online';
    const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const baseUrl = `${proto}://${host}`;
    const publicKey = server.publicKey || 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... portalops-deployer';
    const username = server.username || 'portalops';

    const script = `#!/bin/bash
# ==============================================================================
# PortalOps Automatic Server Configuration Script
# Server Target: ${server.name} (${server.host})
# ==============================================================================
set -e

# Colors
C_GREEN='\\033[0;32m'
C_BLUE='\\033[0;34m'
C_YELLOW='\\033[1;33m'
C_RESET='\\033[0m'

echo -e "\${C_BLUE}==> [1/4] Starting PortalOps dedicated runner provisioning...\${C_RESET}"

# Ensure root privileges
if [ "$(id -u)" -ne 0 ]; then
  echo -e "\${C_YELLOW}Error: This script must be run as root (or with sudo).\${C_RESET}" >&2
  exit 1
fi

# Ensure curl is installed
if ! command -v curl >/dev/null 2>&1; then
  echo -e "\${C_BLUE}==> Installing curl utility...\${C_RESET}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq curl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl
  fi
fi

# 1. Create dedicated portalops deploy user
echo -e "\${C_BLUE}==> [2/4] Setting up dedicated deploy user: '${username}'...\${C_RESET}"
if ! id "${username}" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd -m -s /bin/bash "${username}"
  else
    adduser -D -s /bin/bash "${username}"
  fi
  echo -e "\${C_GREEN}✓ User '${username}' created successfully.\${C_RESET}"
else
  echo -e "\${C_GREEN}✓ User '${username}' already exists.\${C_RESET}"
fi

# 2. Authorize PortalOps Dedicated Ed25519 Public Key
echo -e "\${C_BLUE}==> [3/4] Configuring ~/.ssh/authorized_keys...\${C_RESET}"
USER_HOME=$(eval echo "~${username}")
SSH_DIR="\${USER_HOME}/.ssh"
AUTH_KEYS="\${SSH_DIR}/authorized_keys"

mkdir -p "\${SSH_DIR}"
chmod 700 "\${SSH_DIR}"

# Append public key if not already present
if ! grep -qF "${publicKey}" "\${AUTH_KEYS}" 2>/dev/null; then
  echo "${publicKey}" >> "\${AUTH_KEYS}"
fi

chmod 600 "\${AUTH_KEYS}"
chown -R "${username}:${username}" "\${SSH_DIR}"
echo -e "\${C_GREEN}✓ Public key authorized for deployment automation.\${C_RESET}"

# 3. Grant scoped passwordless sudo for deployment & webserver binaries
echo -e "\${C_BLUE}==> [4/4] Configuring scoped sudoers policy...\${C_RESET}"
SUDOERS_FILE="/etc/sudoers.d/99-portalops"
mkdir -p /etc/sudoers.d

cat << 'EOF' > "\${SUDOERS_FILE}"
# PortalOps scoped deployment rights (passwordless)
${username} ALL=(ALL) NOPASSWD: /usr/sbin/service, /bin/systemctl, /usr/bin/systemctl, /usr/sbin/nginx, /usr/bin/nginx, /usr/local/bin/pm2, /usr/bin/pm2, /usr/bin/docker, /usr/local/bin/docker, /usr/bin/certbot, /usr/local/bin/certbot
EOF
chmod 0440 "\${SUDOERS_FILE}"

# 4. Notify PortalOps platform of completion
echo -e "\${C_BLUE}==> Finalizing handshake with PortalOps...\${C_RESET}"
CALLBACK_PAYLOAD="{\\"hostname\\":\\"$(hostname)\\",\\"os\\":\\"$(uname -s)\\",\\"kernel\\":\\"$(uname -r)\\"}"
curl -s -X POST "${baseUrl}/setup/${token}/complete" \\
  -H "Content-Type: application/json" \\
  -d "\${CALLBACK_PAYLOAD}" >/dev/null 2>&1 || true

echo -e "\${C_GREEN}===============================================================================\${C_RESET}"
echo -e "\${C_GREEN}🎉 Server configured successfully! PortalOps can now deploy to this host.\${C_RESET}"
echo -e "\${C_GREEN}===============================================================================\${C_RESET}"
`;

    res.set({
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Disposition': `inline; filename="setup-${token}.sh"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.send(script);
  } catch (err) {
    logger.error({ err, token }, 'Failed to serve server setup script');
    res.status(500).set('Content-Type', 'text/plain').send(
      '#!/bin/bash\necho "Internal Server Error serving setup script." >&2\nexit 1\n'
    );
  }
});

/**
 * POST /setup/:token/complete
 * Handshake callback invoked by the curl script after running on the server.
 */
router.post('/:token/complete', async (req, res) => {
  const token = (req.params.token || '').replace(/\.sh$/i, '');

  try {
    const server = await serverModel.findBySetupToken(token);
    if (!server) {
      res.status(404).json({ error: 'Setup token not found' });
      return;
    }

    const updated = await serverModel.update(server.id, {
      setupCompletedAt: new Date(),
      lastCheckAt: new Date(),
      lastCheckOk: true,
    });

    logger.info({ serverId: server.id, name: server.name }, 'Server 1-line setup completed successfully');

    res.json({
      ok: true,
      serverId: server.id,
      name: server.name,
      message: 'Server configured and connected successfully',
    });
  } catch (err) {
    logger.error({ err, token }, 'Failed to complete server setup handshake');
    res.status(500).json({ error: 'Failed to process setup callback' });
  }
});

/**
 * GET /setup/:token/status
 * Polling endpoint for frontend while user runs curl script in their VPS terminal.
 */
router.get('/:token/status', async (req, res) => {
  const token = (req.params.token || '').replace(/\.sh$/i, '');

  try {
    const server = await serverModel.findBySetupToken(token);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    res.json({
      configured: Boolean(server.setupCompletedAt),
      completedAt: server.setupCompletedAt,
      lastCheckOk: server.lastCheckOk,
      server: {
        id: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        publicKey: server.publicKey,
      },
    });
  } catch (err) {
    logger.error({ err, token }, 'Failed to get server setup status');
    res.status(500).json({ error: 'Failed to check setup status' });
  }
});

module.exports = router;

