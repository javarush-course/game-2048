# Сервер рекордов игры 2048 (образ jrgames/2048-scores)
ARG NODE_IMAGE=node:26-alpine
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="2048 scores" \
      org.opencontainers.image.description="Сервер рекордов игры 2048: HTTP на порту 3000, рекорды хранит Redis (redis:6379)" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
# зависимостей нет — npm install не нужен
COPY package.json server.js ./

# адрес Redis записан в образе: в compose.yaml проекта часть с Redis называется redis
ENV PORT=3000 \
    REDIS_HOST=redis \
    REDIS_PORT=6379

EXPOSE 3000
USER node

# без docker-entrypoint.sh базового образа: программа контейнера — сама node,
# в docker ps колонка COMMAND — "node server.js"
ENTRYPOINT []
CMD ["node", "server.js"]
