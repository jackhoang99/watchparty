FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy only what the server needs at runtime
COPY server.js ./
COPY public ./public
COPY extension ./extension

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
