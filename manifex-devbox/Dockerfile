FROM ubuntu:24.04

# Phase 2B pivot-back: v3.1-lean.
# The devbox is dumb. It is a remote filesystem + shell that a Claude
# agent running INSIDE manifex-wip reaches into via /__files, /__write,
# /__read, /__ls, /__exec. No Claude CLI on the box, no ANTHROPIC_API_KEY
# in the box env, no builder intelligence. Everything LLM-shaped runs
# server-side on manifex-wip; the box just executes bash and stores
# files. Same base image shape as v3-claude-agent minus Claude Code
# install.

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_VERSION=20 \
    AGENT_PORT=8080 \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash curl ca-certificates git tini \
      build-essential python3 python3-pip sqlite3 ripgrep \
      unzip \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /agent /app/workspace
COPY agent/server.js /agent/server.js

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","/agent/server.js"]
