#!/bin/sh
# One-time setup of the owner's VPS storage for TeleTVShare. Run as root on the VPS:
#   git -C /opt/teletvshare pull && sh /opt/teletvshare/helper/vps-tunnel-setup.sh
# What it does:
#  - installs Cloudflare's official cloudflared (from Cloudflare's GitHub releases)
#  - runs a Cloudflare "quick tunnel" as the teletv user: OUTBOUND only, no port is opened on this server
#    and the firewall is not touched. It forwards only to the helper's file server on 127.0.0.1:8090, which
#    serves only files with a link signed by the TeleTVShare Worker (links expire after 6 hours).
#  - turns on VPS storage for the helper (folder /var/lib/teletvshare/store, at most 5 GB, owner only)
# Undo: systemctl disable --now teletvshare-tunnel; apt remove cloudflared
set -e
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -sL --max-time 180 -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb >/dev/null
  rm -f /tmp/cloudflared.deb
fi
cloudflared --version | head -1

install -d -o teletv -g teletv -m 750 /var/lib/teletvshare/store
grep -q '^VPS_STORE=' /etc/teletvshare/helper.env || printf 'VPS_STORE=/var/lib/teletvshare/store\nFILE_PORT=8090\nTUNNEL_METRICS=http://127.0.0.1:20241\n' >> /etc/teletvshare/helper.env

cat > /etc/systemd/system/teletvshare-tunnel.service <<'EOF'
[Unit]
Description=TeleTVShare tunnel (outbound only) for the owner files on this VPS
After=network-online.target
Wants=network-online.target

[Service]
User=teletv
Group=teletv
Environment=HOME=/var/lib/teletvshare
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20241 --url http://127.0.0.1:8090
Restart=always
RestartSec=10
MemoryMax=200M
CPUQuota=50%
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/teletvshare

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now teletvshare-tunnel
systemctl restart teletvshare-helper
sleep 15
echo "tunnel: $(systemctl is-active teletvshare-tunnel)  helper: $(systemctl is-active teletvshare-helper)  x-ui: $(systemctl is-active x-ui)"
curl -s --max-time 5 http://127.0.0.1:20241/quicktunnel; echo
