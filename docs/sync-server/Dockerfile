FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src/sync-server.js src/sync-storage.js ./src/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 18445
CMD ["node", "src/sync-server.js"]
