#!/bin/sh
# Owner's web panel (users only) on the VPS, at https://<own domain>/panel. Run as root on the VPS:
#   git -C /opt/teletvshare pull && sh /opt/teletvshare/helper/vps-panel-setup.sh
# Needs: vps-domain-setup.sh done (Caddy on the own domain), and /etc/teletvshare/panel.env holding
# PANEL_SECRET=... (the same value as the Worker secret PANEL_SECRET; never commit it).
# What it does:
#  - adds WORKER_URL (from helper.env) and PANEL_URL (from the Caddyfile) to panel.env
#  - runs helper/panel.py as the teletv user (systemd teletvshare-panel) on 127.0.0.1:8091 only
#  - adds ONE route to Caddy: /panel and /panel/* go to 127.0.0.1:8091. No port or firewall change.
#  - on first start, temporary login details are sent to the owner through the admin bot
# New login details later: send /panel to the admin bot.
# Undo: systemctl disable --now teletvshare-panel; restore /etc/caddy/Caddyfile.bak-panel; systemctl reload caddy
set -e
ENVF=/etc/teletvshare/panel.env
APP=/opt/teletvshare
[ -s "$ENVF" ] && grep -q '^PANEL_SECRET=.\{32,\}' "$ENVF" || { echo "$ENVF with PANEL_SECRET is missing - nothing changed"; exit 1; }
DOMAIN=$(sed -n 's/^https:\/\/\([a-z0-9.-]*\) {$/\1/p' /etc/caddy/Caddyfile | head -1)
[ -n "$DOMAIN" ] || { echo "own domain not found in /etc/caddy/Caddyfile (run vps-domain-setup.sh first) - nothing changed"; exit 1; }
PY="$APP/venv/bin/python"; [ -x "$PY" ] || PY=$(command -v python3)
WURL=$(sed -n 's/^WORKER_URL=//p' /etc/teletvshare/helper.env | head -1)
[ -n "$WURL" ] || { echo "WORKER_URL not found in /etc/teletvshare/helper.env - nothing changed"; exit 1; }

grep -q '^WORKER_URL=' "$ENVF" || echo "WORKER_URL=$WURL" >> "$ENVF"
grep -q '^PANEL_URL=' "$ENVF" || echo "PANEL_URL=https://$DOMAIN/panel" >> "$ENVF"
chown root:root "$ENVF"; chmod 600 "$ENVF"
install -d -o teletv -g teletv -m 700 /var/lib/teletvshare

cat > /etc/systemd/system/teletvshare-panel.service <<EOF
[Unit]
Description=TeleTVShare owner's web panel
After=network-online.target
Wants=network-online.target

[Service]
User=teletv
EnvironmentFile=$ENVF
Environment=PANEL_PORT=8091 PANEL_STATE=/var/lib/teletvshare/panel.json PYTHONUNBUFFERED=1
ExecStart=$PY $APP/helper/panel.py
Restart=always
RestartSec=5
MemoryMax=200M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/teletvshare

[Install]
WantedBy=multi-user.target
EOF

if ! grep -q '@panel path' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-panel
  awk '
    /^\thandle \{$/ && !done {
      print "\t@panel path /panel /panel/*"
      print "\thandle @panel {"
      print "\t\treverse_proxy 127.0.0.1:8091"
      print "\t}"
      done = 1
    }
    { print }
  ' /etc/caddy/Caddyfile.bak-panel > /etc/caddy/Caddyfile
  grep -q '@panel path' /etc/caddy/Caddyfile || { cp /etc/caddy/Caddyfile.bak-panel /etc/caddy/Caddyfile; echo "could not add the Caddy route - nothing changed in Caddy"; exit 1; }
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { cp /etc/caddy/Caddyfile.bak-panel /etc/caddy/Caddyfile; echo "Caddy rejected the new route - restored"; exit 1; }
fi

systemctl daemon-reload
systemctl enable teletvshare-panel >/dev/null 2>&1
systemctl restart teletvshare-panel
systemctl reload caddy
sleep 3
echo "panel: $(systemctl is-active teletvshare-panel)  caddy: $(systemctl is-active caddy)  helper: $(systemctl is-active teletvshare-helper)  x-ui: $(systemctl is-active x-ui)"
echo "page: $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/panel")  api without login (should be 401): $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/panel/api/users")"
