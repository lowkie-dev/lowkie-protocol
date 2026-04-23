FROM node:20.18.0-alpine

WORKDIR /app

COPY apps/backend/package.json ./package.json
COPY apps/backend/yarn.lock ./yarn.lock

RUN yarn install --frozen-lockfile

COPY apps/backend ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000

EXPOSE 10000

CMD ["yarn", "start"]