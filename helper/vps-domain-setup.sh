#!/bin/sh
# Serve the owner's TeleTVShare files on the owner's own domain (HTTPS), so the TV plays them without a VPN.
# Run as root on the VPS:   sh /opt/teletvshare/helper/vps-domain-setup.sh your.domain.example
# What it does:
#  - installs Caddy (web server) which gets a free Let's Encrypt certificate by itself
#  - Caddy listens on port 443 only (port 80 is left alone, so x-ui's own certificates are not affected)
#    and passes ONLY /v/ /c/ /t/ links to the helper on 127.0.0.1:8090; every such link must carry a valid
#    signature made by the TeleTVShare Worker. /panel goes to the owner's web panel on 127.0.0.1:8091
#    (vps-panel-setup.sh). Anything else gets 404.
#  - opens 443/tcp in ufw (the only firewall change)
# Undo: systemctl disable --now caddy; ufw delete allow 443/tcp
set -e
DOMAIN="$1"
[ -n "$DOMAIN" ] || { echo "usage: sh $0 your.domain"; exit 1; }
if ss -tln | grep -q ':443 '; then
  ss -tlnp | grep ':443 ' | grep -q caddy || { echo "port 443 is already used by another program - stopping, nothing changed"; exit 1; }
fi
if ! command -v caddy >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
fi
caddy version | head -1
cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
	auto_https disable_redirects
}

https://$DOMAIN {
	tls {
		issuer acme {
			disable_http_challenge
		}
	}
	@media path /v/* /c/* /t/*
	handle @media {
		reverse_proxy 127.0.0.1:8090 {
			flush_interval -1
		}
	}
	@panel path /panel /panel/*
	handle @panel {
		reverse_proxy 127.0.0.1:8091
	}
	handle {
		respond 404
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null
ufw allow 443/tcp comment 'TeleTVShare media (Caddy)' >/dev/null
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 20
echo "caddy: $(systemctl is-active caddy)  helper: $(systemctl is-active teletvshare-helper)  x-ui: $(systemctl is-active x-ui)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/v/AAAAAAAAAAAAAAAA/x.mp4?sig=0" || true)
echo "https check (should be 403): $code"
