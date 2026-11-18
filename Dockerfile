# Dusk Cellar 컨테이너 이미지 — 리스 컨테이너 옆에 붙이는 사이드카용.
# 실행기(리스를 자식으로 켜는 부분) 없이 Cellar 서버(--role-server)만 돈다. 자세한 건 README '도커로 붙이기'.
# Cellar 본체는 Node 기본 모듈만 쓴다. 옛 형식 세이브용 msgpackr·fflate만 /opt/risu-host에 따로 둔다. 세이브 SQLite 온라인 백업(node:sqlite)에 Node 22.16 이상이 필요하다.
FROM node:22-slim

# 옛 형식 database.bin(PocketRisu 등)을 풀 때 Cellar는 리스의 msgpackr·fflate를 빌려 쓴다(--host-dir).
# 사이드카에는 리스 앱 폴더가 없으므로 PocketRisu와 같은 버전을 따로 넣어 두고 기본 host-dir로 쓴다(CELLAR_HOST_DIR로 바꿀 수 있음).
WORKDIR /opt/risu-host
RUN npm install --no-save --no-audit --no-fund --omit=optional msgpackr@1.11.9 fflate@0.8.2 && npm cache clean --force

WORKDIR /app
COPY *.cjs ./
COPY engine/ ./engine/
COPY docker/entrypoint.sh /usr/local/bin/cellar-entrypoint
RUN chmod 755 /usr/local/bin/cellar-entrypoint && mkdir -p /data /save

# /data: Cellar 데이터(기억·백업·토큰) · /save: 리스 세이브 폴더(리스 컨테이너와 같은 폴더를 붙인다)
VOLUME ["/data"]
ENV NODE_ENV=production
EXPOSE 6011
ENTRYPOINT ["cellar-entrypoint"]
