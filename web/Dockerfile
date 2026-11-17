# Страница игры 2048 (образ jrgames/2048-web): nginx отдаёт игру — HTML, стили и скрипт
ARG NGINX_IMAGE=nginx:1.29-alpine
FROM ${NGINX_IMAGE}

LABEL org.opencontainers.image.title="2048 web" \
      org.opencontainers.image.description="Страница игры 2048 с таблицей рекордов (nginx, порт 80); рекорды — у сервера рекордов на порту 3000 того же компьютера" \
      org.opencontainers.image.licenses="MIT"

COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf
COPY html/ /usr/share/nginx/html/

# порт 80, команда и docker-entrypoint.sh — от nginx:alpine
