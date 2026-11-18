# Dusk Cellar 컨테이너 이미지 — 리스 컨테이너 옆에 붙이는 사이드카용.
# 실행기(리스를 자식으로 켜는 부분) 없이 Cellar 서버(--role-server)만 돈다. 자세한 건 README '도커로 붙이기'.
# Node 기본 모듈만 쓴다(npm install 없음). 세이브 SQLite 온라인 백업(node:sqlite)에 Node 22.16 이상이 필요하다.
FROM node:22-slim

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
