# dsh-node-agent — production image.
#
# NOTE: do NOT pass --no-open to `dsh web`: it is an unknown option that
# breaks commander parsing ("unknown option '--patch'"). The headless
# container just fails the browser-open silently.
FROM node:22-slim

# dsh version MUST match the version the plugin was developed/verified
# against (CLI 0.1.0-rc.7, sub-packages 0.1.0-rc.8).
RUN npm i -g @deepseek-ai/dsh@0.1.0-rc.7

COPY . /opt/dsh-node-agent
WORKDIR /opt/dsh-node-agent

# Install only the plugin's own deps (@microsoft/signalr + runtime deps);
# @deepseek-ai/* peers come from the host. --legacy-peer-deps prevents npm
# from auto-installing (and following symlinked) peers.
RUN npm install --legacy-peer-deps --omit=dev \
 && node build-client.mjs

# Dependency identity: the plugin's @deepseek-ai/* must resolve to the SAME
# physical modules as the host (the @Remote marker table is a module-private
# WeakMap; a second copy silently breaks Remote discovery). Placing the
# plugin inside the dsh package tree makes resolution walk into the host's
# node_modules naturally.
RUN mkdir -p /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
 && ln -sfn /opt/dsh-node-agent /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-node-agent

# client-modules resolves plugin packages from the profile dir — link the
# anchor (adjust DSH_HOME if it is a mounted volume; then link at runtime).
# RUN mkdir -p /data/dsh-home/profiles/web/node_modules \
#  && ln -sfn /opt/dsh-node-agent /data/dsh-home/profiles/web/node_modules/dsh-node-agent

# Env: SUNSET_HUB_URL / SUNSET_NODE_ID / SUNSET_NODE_TOKEN / SUNSET_MAX_CONCURRENCY ...
# Production hub MUST be HTTPS (the node key rides the access_token query param).
CMD ["dsh", "web", "--patch", "/opt/dsh-node-agent/cordis.yml"]
