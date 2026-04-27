FROM node:20-alpine

WORKDIR /app

COPY server.js package.json ./
COPY public/ ./public/

EXPOSE 3377

VOLUME /app/data

CMD ["node", "server.js"]
