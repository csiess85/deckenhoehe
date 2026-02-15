FROM node:22-alpine

WORKDIR /app

COPY server.js app.js index.html help.html stats.html history.html favicon.svg package.json ./

ENV PORT=5556
EXPOSE 5556

CMD ["node", "server.js"]
