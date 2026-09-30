# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Official Node image, immutable multi-platform index verified 2026-09-12.
FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS base-tools
ARG TARGETARCH
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    MW_FFMPEG=/usr/bin/ffmpeg MW_FFPROBE=/usr/bin/ffprobe \
    MW_YTDLP=/usr/local/bin/yt-dlp MW_DATA_DIR=/data \
    MW_HOST=127.0.0.1 MW_PORT=4319
ENTRYPOINT []
# Snapshot repositories use Debian's signed archive metadata and package hashes.
RUN printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/20260912T000000Z\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/20260912T000000Z\nSuites: trixie-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg=7:7.1.5-0+deb13u1 fonts-dejavu-core ca-certificates \
    && mkdir -p /usr/local/share/media-workbench /data /app/test-output \
    && dpkg-query -W -f='${Package}\t${Version}\t${source:Package}\t${source:Version}\n' > /usr/local/share/media-workbench/debian-packages.tsv \
    && rm -rf /var/lib/apt/lists/* \
    && chown node:node /data /app/test-output
COPY deploy/install-ytdlp.mjs /tmp/install-ytdlp.mjs
RUN node /tmp/install-ytdlp.mjs "$TARGETARCH" && rm /tmp/install-ytdlp.mjs

FROM base-tools AS ffmpeg-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential nasm pkg-config gnupg \
    libx264-dev libx265-dev libsvtav1enc-dev libaom-dev libfreetype-dev libfontconfig-dev libharfbuzz-dev libfribidi-dev libgnutls28-dev
COPY deploy/install-ffmpeg-source.mjs /tmp/install-ffmpeg-source.mjs
RUN node /tmp/install-ffmpeg-source.mjs
WORKDIR /tmp/ffmpeg-9.0.1
RUN ./configure --prefix=/opt/media-tools --disable-debug --disable-doc --disable-ffplay \
    --enable-gpl --enable-libx264 --enable-libx265 --enable-libsvtav1 --enable-libaom \
    --enable-libfreetype --enable-libfontconfig --enable-libharfbuzz --enable-libfribidi --enable-gnutls \
    --disable-xlib --disable-sdl2 \
    && make -j4 && make install \
    && cp config.h ffbuild/config.mak /usr/local/share/media-workbench/

FROM base-tools AS toolchain
COPY --from=ffmpeg-build /opt/media-tools/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=ffmpeg-build /opt/media-tools/bin/ffprobe /usr/bin/ffprobe
COPY --from=ffmpeg-build /tmp/ffmpeg-9.0.1.tar.xz /usr/local/share/media-workbench/
COPY --from=ffmpeg-build /usr/local/share/media-workbench/config.h /usr/local/share/media-workbench/config.h
COPY --from=ffmpeg-build /usr/local/share/media-workbench/config.mak /usr/local/share/media-workbench/config.mak
RUN /usr/bin/ffmpeg -version > /usr/local/share/media-workbench/ffmpeg-version.txt \
    && cd /usr/bin && sha256sum ffmpeg ffprobe > /usr/local/share/media-workbench/ffmpeg-binaries.sha256

FROM toolchain AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN node scripts/build.mjs

FROM build AS test
USER node
CMD ["node", "--import", "tsx", "--test", "--test-concurrency=1", "tests/media.test.ts", "tests/security-process.test.ts"]

FROM build AS linux-package
RUN node scripts/package-linux.mjs

FROM scratch AS linux-artifact
COPY --from=linux-package /app/release/ /

FROM toolchain AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM toolchain AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY deploy/README.md ./CONTAINER_README.md
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s CMD /usr/local/bin/node -e "fetch('http://127.0.0.1:4319/api/v1/capabilities').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["/usr/local/bin/node", "dist/server/main.js"]
