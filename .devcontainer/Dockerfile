# Keep the tag equal to .bun-version.
FROM oven/bun:1.4.2-debian

ARG GITLEAKS_VERSION=8.30.1
# bubblewrap and socat: the browser tests need the Linux sandbox available, as in CI (ci.yml). zip: the signing tests.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git procps socat unzip zip \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) ga=x64 ;; arm64) ga=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
  && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${ga}.tar.gz" \
    | tar -xz -C /usr/local/bin gitleaks \
  && gitleaks version

USER bun
