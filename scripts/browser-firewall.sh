#!/bin/bash
# Keep the shared browser (sili-browser network) away from everything internal.
# The browser opens arbitrary URLs (`screenshot`, later sandbox code), so it
# must not reach mongo/napcat/CPA, the VPC, the host, or Aliyun's metadata
# service at 100.100.100.200 (machine credentials).
#
# Idempotent; run as root after docker starts (scripts/sili-browser-firewall.service).
# DNS keeps working: containers resolve through docker's embedded DNS, which
# queries upstream from the host's namespace, not through these chains.
set -euo pipefail

SUBNET=172.30.0.0/24 # sili-browser in docker-compose.yml
CHAIN=SILI-BROWSER

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -A "$CHAIN" -d "$dst" -j DROP
done
iptables -A "$CHAIN" -j RETURN

# Forwarded traffic (other containers, the VPC, metadata). DOCKER-USER exists
# once dockerd has started.
iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null ||
  iptables -I DOCKER-USER -s "$SUBNET" -j "$CHAIN"

# The host itself (sshd and anything else listening on it).
iptables -C INPUT -s "$SUBNET" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP 2>/dev/null ||
  iptables -I INPUT -s "$SUBNET" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP

echo "browser firewall applied for $SUBNET"
