FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json index.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node web ./web
COPY --chown=node:node vendor ./vendor
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production
EXPOSE 47821
ENTRYPOINT ["node", "bin/sentinel.mjs", "ui", "--no-open", "--data-dir", "/data"]
