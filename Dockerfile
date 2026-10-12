# Reel-Werkstatt 2.0: Node + ffmpeg (Untertitel) + Chromium und HyperFrames (Effekte) + OpenCV (Gesichtsvermessung)
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates fontconfig curl chromium python3 python3-venv fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Python-Umgebung für die Gesichtsvermessung (OpenCV mit YuNet, MIT-Lizenz)
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir opencv-python-headless==4.10.0.84 numpy==1.26.4
ENV PATH="/opt/py/bin:$PATH"
RUN mkdir -p models && curl -fsSL -o models/yunet.onnx "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
# HyperFrames (Apache 2.0) und GSAP für die Effekt-Ebenen
COPY container-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && mkdir -p assets/fonts && cp node_modules/gsap/dist/gsap.min.js assets/
ENV HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium DO_NOT_TRACK=1 HYPERFRAMES_TELEMETRY_DISABLED=1
# Freie Schriften (SIL Open Font License) aus dem Google-Fonts-Archiv
RUN set -e; for f in poppins/Poppins-Medium.ttf poppins/Poppins-SemiBold.ttf poppins/Poppins-Bold.ttf poppins/Poppins-ExtraBold.ttf poppins/Poppins-Black.ttf poppins/Poppins-BoldItalic.ttf dmserifdisplay/DMSerifDisplay-Regular.ttf dmserifdisplay/DMSerifDisplay-Italic.ttf anton/Anton-Regular.ttf archivoblack/ArchivoBlack-Regular.ttf caveatbrush/CaveatBrush-Regular.ttf bebasneue/BebasNeue-Regular.ttf spacemono/SpaceMono-Bold.ttf abrilfatface/AbrilFatface-Regular.ttf pacifico/Pacifico-Regular.ttf; do \
      mkdir -p fonts && curl -fsSL -o "fonts/$(basename $f)" "https://raw.githubusercontent.com/google/fonts/main/ofl/$f"; done; \
    cp fonts/Poppins-*.ttf fonts/DMSerifDisplay-Regular.ttf assets/fonts/; cp fonts/*.ttf /usr/share/fonts/ && fc-cache -f
COPY server.cjs render.cjs effects.cjs layout.py ./
COPY kling.wav ping.wav pop.wav whoosh.wav klick.wav tada.wav ./sounds/
COPY OFL.txt ./fonts/
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.cjs"]
