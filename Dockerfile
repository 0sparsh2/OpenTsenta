# Ferry: API + dashboard + browser apply agent in one container.
# Playwright's image ships Chromium and its system dependencies.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app
# Password sign-in: the image is for hosting, and dev mode signs anyone in by email alone.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    HEADLESS=true \
    AUTH_MODE=password

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --include=dev --workspace apps/server --workspace apps/web --workspace apps/cli --include-workspace-root

COPY . .
RUN npm run build --workspace apps/web

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/server/src/index.ts"]
