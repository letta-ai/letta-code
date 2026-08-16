FROM node:22.19-bookworm-slim

ARG LETTA_CODE_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    LETTA_PACKAGE_MANAGER=npm

# Letta Code can execute tools and skills inside this image. Keep the common
# runtimes available while leaving project-specific dependencies to downstream
# images and mounted workspaces.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      cron \
      curl \
      dnsutils \
      file \
      git \
      iproute2 \
      iputils-ping \
      jq \
      lsof \
      make \
      g++ \
      netcat-openbsd \
      openssh-client \
      procps \
      python3 \
      wget; \
    ln -sf /usr/bin/python3 /usr/local/bin/python; \
    npm install --global "@letta-ai/letta-code@${LETTA_CODE_VERSION}"; \
    apt-get purge -y make g++; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/letta-container-entrypoint

ENV LETTA_SYSTEM_CRON_DIR=/root/.letta/system-cron \
    LETTA_SYSTEM_ROOT_CRONTAB=/root/.letta/system-crontab/root

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/letta-container-entrypoint"]
CMD ["letta", "--help"]
