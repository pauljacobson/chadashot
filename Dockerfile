ARG FRESHRSS_VERSION=1.29.1
FROM freshrss/freshrss:${FRESHRSS_VERSION}

# Preserve FreshRSS's startup logic while removing Railway's restored default site.
RUN rm -f /etc/apache2/sites-enabled/000-default.conf \
    && mv Docker/entrypoint.sh Docker/entrypoint.freshrss.sh
COPY --chmod=755 docker-entrypoint-railway.sh Docker/entrypoint.sh
