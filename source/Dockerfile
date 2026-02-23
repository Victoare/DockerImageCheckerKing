FROM node:20-alpine

ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

EXPOSE 80

CMD ["node", "server.js"]
