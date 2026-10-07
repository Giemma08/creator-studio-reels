# Reel-Werkstatt: Node + ffmpeg (mit libass für Untertitel)
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates fontconfig \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.cjs render.cjs ./
COPY kling.wav ping.wav pop.wav whoosh.wav klick.wav tada.wav ./sounds/
COPY Poppins-Bold.ttf OFL.txt ./fonts/
RUN cp fonts/*.ttf /usr/share/fonts/ && fc-cache -f
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.cjs"]
