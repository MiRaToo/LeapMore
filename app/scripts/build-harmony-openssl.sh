#!/bin/sh
set -eu

# OpenSSL upstream release checksum: openssl-3.5.4.tar.gz.sha256.
expected=967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99
if [ "$#" -ne 2 ]; then
  echo 'Usage: build-harmony-openssl.sh <openssl-3.5.4.tar.gz> <new-output-directory>' >&2
  exit 2
fi
tarball=$1
output=$2
case "$output" in /*) ;; *) output="$(pwd)/$output" ;; esac
[ -f "$tarball" ] || { echo 'Source archive not found' >&2; exit 1; }
actual=$(shasum -a 256 "$tarball" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo 'OpenSSL archive SHA-256 mismatch' >&2; exit 1; }
[ ! -e "$output" ] || { echo 'Output already exists; choose a new directory' >&2; exit 1; }
llvm=${OHOS_LLVM_BIN:-/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native/llvm/bin}
for tool in aarch64-unknown-linux-ohos-clang x86_64-unknown-linux-ohos-clang llvm-ar llvm-ranlib llvm-strip; do
  [ -x "$llvm/$tool" ] || { echo "Missing OHOS LLVM tool: $tool" >&2; exit 1; }
done
work=$(mktemp -d "${TMPDIR:-/tmp}/leap-openssl.XXXXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$output"
for spec in 'arm64-v8a aarch64 linux-aarch64' 'x86_64 x86_64 linux-x86_64'; do
  set -- $spec
  abi=$1; target=$2; platform=$3
  mkdir "$work/$abi"
  tar -xzf "$tarball" -C "$work/$abi" --strip-components 1
  (
    cd "$work/$abi"
    # OpenSSL includes Configure's flags verbatim in libcrypto's version data.
    # Apply the host-specific source mapping only when the compiler runs.
    mkdir "$work/$abi-cc"
    export CC="$target-unknown-linux-ohos-clang" AR=llvm-ar RANLIB=llvm-ranlib
    export LEAPMORE_OPENSSL_CLANG="$llvm/$CC" LEAPMORE_OPENSSL_SOURCE="$PWD"
    cat > "$work/$abi-cc/$CC" <<'SH'
#!/bin/sh
exec "$LEAPMORE_OPENSSL_CLANG" "-ffile-prefix-map=$LEAPMORE_OPENSSL_SOURCE=." "$@"
SH
    chmod +x "$work/$abi-cc/$CC"
    export PATH="$work/$abi-cc:$llvm:$PATH"
    perl Configure "$platform" shared no-tests --prefix=/usr --openssldir=/etc/ssl
    make -j"${JOBS:-8}" build_libs
    cp LICENSE.txt "$output/LICENSE.txt"
    mkdir -p "$output/libs/$abi" "$output/openssl/$abi"
    cp libcrypto.so.3 libssl.so.3 "$output/libs/$abi/"
    "$llvm/llvm-strip" --strip-debug "$output/libs/$abi/libcrypto.so.3" "$output/libs/$abi/libssl.so.3"
    cp -R include "$output/openssl/$abi/"
  )
done
