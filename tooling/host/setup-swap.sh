#!/bin/bash
# Memory headroom for dispatch-dev: compressed RAM swap (zram) first, a 2 GB swap file on
# disk as the last resort. Run once with sudo; running it again changes nothing.
set -euo pipefail

# 1. zram: idle memory, including /tmp files, is compressed in RAM instead of held as is.
apt-get install -y systemd-zram-generator
cat > /etc/systemd/zram-generator.conf <<'CONF'
[zram0]
zram-size = ram / 2
compression-algorithm = zstd
swap-priority = 100
CONF
systemctl daemon-reload
systemctl restart systemd-zram-setup@zram0.service

# 2. A 2 GB swap file, used only once zram is full (lower priority).
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show=NAME --noheadings | grep -qx /swapfile || swapon --priority 10 /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw,pri=10 0 0' >> /etc/fstab

swapon --show
