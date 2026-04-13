FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_VERSION=20 \
    AGENT_PORT=8080 \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash curl ca-certificates git tini \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /agent /app/workspace
COPY agent/server.js /agent/server.js

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","/agent/server.js"]
