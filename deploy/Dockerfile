# Build from the repo root, as compose.yaml does:
#   docker build -f deploy/Dockerfile -t cli-funnel .

FROM node:22-slim AS build
WORKDIR /src
COPY . .
# Only the cli-funnel package and the root's build tools. The other workspaces are not needed.
RUN npm ci -w cli-funnel --include-workspace-root \
 && npm run build -w cli-funnel \
 && mkdir /out \
 && npm pack -w cli-funnel --pack-destination /out

FROM node:22-slim

# The CLIs cli-funnel drives. Drop the ones you do not use.
ARG CLIS="@anthropic-ai/claude-code @openai/codex"

# Installs the package built above, so the image matches this checkout, not the version on npm.
RUN --mount=type=bind,from=build,source=/out,target=/out npm install -g /out/cli-funnel-*.tgz ${CLIS}

USER node
WORKDIR /workspace
ENTRYPOINT ["cli-funnel"]
# Listens on all interfaces inside the container. compose.yaml publishes the port on the tailnet address only.
CMD ["serve", "--host", "0.0.0.0", "--fs-root", "/workspace"]
