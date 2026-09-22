# Builds the web app, then runs the API and serves the web app from one container. (Not yet tested with Docker.)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server
COPY server server
COPY db db
COPY --from=build /app/web/dist web/dist
WORKDIR /app/server
EXPOSE 4000
CMD ["node", "src/index.js"]
