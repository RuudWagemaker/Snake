# Debian (glibc) so the prebuilt WebRTC library (node-datachannel) works.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
ENV PORT=3000
# Player profiles and leaderboards; deploy/docker-compose.yml keeps /data in a volume.
ENV STATS_FILE=/data/stats.json
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
