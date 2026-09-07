ARG FRESHRSS_VERSION=1.29.1
FROM freshrss/freshrss:${FRESHRSS_VERSION}

# Prevent Debian's default virtual host from taking precedence on Railway.
RUN rm -f /etc/apache2/sites-enabled/000-default.conf
