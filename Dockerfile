# Dockerfile — builds the Anchor app for Fly.io / any container host.
# Uses Node 22 (required for the built-in node:sqlite module).

FROM node:22-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the app (frontend files live in the root)
COPY . .

# Sanity check: the frontend MUST be present. If this fails, index.html / app.js
# did not make it into the repo / build context.
RUN test -f /app/index.html || (echo "ERROR: index.html missing from build context" && exit 1)
RUN test -f /app/app.js     || (echo "ERROR: app.js missing from build context" && exit 1)

# Verify sharp loaded its native binary correctly for this platform.
RUN node -e "require('sharp'); console.log('sharp OK')"

# The persistent volume mounts here (see fly.toml [mounts]).
RUN mkdir -p /app/data

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "server.js"]
