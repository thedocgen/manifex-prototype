FROM node:20-alpine

WORKDIR /app
RUN mkdir -p /app/data

COPY package.json server.js ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
