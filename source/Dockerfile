FROM node:20-alpine

ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}

WORKDIR /app

COPY package.json ./
RUN npm install --production && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server.js store.js docker.js registry.js telegram.js updater.js metrics.js ./
COPY public/ ./public/

EXPOSE 8080

CMD ["node", "server.js"]
