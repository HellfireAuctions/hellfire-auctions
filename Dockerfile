FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

RUN mkdir -p /app/data

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Production schema and migrations are already PostgreSQL in prisma/.
RUN npm run build

CMD ["npm", "run", "docker-start"]
