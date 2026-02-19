FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    dbus-x11 \
    xdotool \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY entrypoint.sh health.py ./
RUN chmod +x entrypoint.sh

EXPOSE 8080

ENV DISPLAY=:99

CMD ["/app/entrypoint.sh"]
