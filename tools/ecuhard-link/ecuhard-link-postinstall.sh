#!/bin/sh
# ECUHARD Baglanti servisi kurulum adimi (component.json postInstall, her kurulumda root olarak current/'dan calisir).
# 1) Veri klasoru: ID7 uygulamasi (uid 124xx) control.json yazabilsin diye 0777.
# 2) Servisin kostugu uid'i (hmi_5000) uplink icin bildir: deploy bu internet-uids dosyasini
#    /var/opt/mgu-uplink/uids.d/ecuhard-link'e kopyalar -> uplink o uid'e internet acar.
set -e
D=/var/opt/ecuhard-link
mkdir -p "$D"
chmod 0777 "$D" 2>/dev/null || true

U=$(id -u hmi_5000 2>/dev/null || echo 5000)
printf '%s\n' "$U" > "$D/internet-uids"

# emniyet kemeri: uplink kuruluysa dogrudan da yaz (deploy senkronu zaten yapar, bu beklemeyi kisaltir)
if [ -d /var/opt/mgu-uplink ]; then
  mkdir -p /var/opt/mgu-uplink/uids.d 2>/dev/null || true
  printf '%s\n' "$U" > /var/opt/mgu-uplink/uids.d/ecuhard-link 2>/dev/null || true
fi

exit 0
