set -euo pipefail
CK=$(printf %s "$CORE_KEY" | tr -d '[:space:]'); export CK
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:CK -in core/key.enc -out "$T/k.pem"
openssl pkeyutl -decrypt -inkey "$T/k.pem" -pkeyopt rsa_padding_mode:oaep -in core/datakey.enc -out "$T/dk"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"$T/dk" -in core/bundle.enc | tar xzf -
sha256sum -c --quiet core/manifest.sha256 && echo "unsealed OK: $(wc -l < core/manifest.sha256) files verified"
