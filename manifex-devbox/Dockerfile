FROM ubuntu:24.04

# Phase 2B pivot: v3-claude-agent.
# Devboxes now run Claude Code CLI as the builder. Manifex never
# generates code directly — each /__run call hands Claude the current
# doc bundle and lets it build/modify /app/workspace like a developer.
# The image therefore ships with: a small Node runtime for the agent
# server, Claude Code CLI (--dangerously-skip-permissions ready), and
# the common dev toolchain Claude will reach for (build tools, python,
# sqlite, ripgrep). Image stays under a few hundred MB.

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

# Claude Code CLI — the whole point of the v3 image. Installed globally
# so any cwd can spawn `claude --dangerously-skip-permissions`.
RUN npm install -g @anthropic-ai/claude-code@latest \
 && claude --version || true

RUN mkdir -p /agent /app/workspace
COPY agent/server.js /agent/server.js

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","/agent/server.js"]
