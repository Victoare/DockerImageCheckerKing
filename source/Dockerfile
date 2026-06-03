FROM node:20-alpine

ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}

WORKDIR /app

COPY package.json ./
RUN npm install --production && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server.js ./
COPY public/ ./public/

EXPOSE 80

CMD ["node", "server.js"]
