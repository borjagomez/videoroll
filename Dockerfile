# Playwright's image already carries Chromium and the system libraries it needs,
# pinned to the same version as the `playwright` dependency - a mismatch there
# makes the browser fail to launch at runtime.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Debian's ffmpeg is built with libass, so `--burn-subs` works here even though
# Homebrew's build on macOS does not support it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

# Dependencies first, so a source change does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN pnpm build

# The catalogue, the saved session and every rendered demo live here. Mount it
# as a volume or a restart loses the library.
ENV VDG_WORKSPACE=/data
VOLUME ["/data"]

EXPOSE 8080
ENV VDG_HOST=0.0.0.0 VDG_PORT=8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "serve"]
