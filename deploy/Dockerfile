FROM node:22-slim

# Pin the versions you have tested, for example --build-arg CLI_FUNNEL_VERSION=0.5.0.
ARG CLI_FUNNEL_VERSION=latest
# The CLIs cli-funnel drives. Drop the ones you do not use.
ARG CLIS="@anthropic-ai/claude-code @openai/codex"

RUN npm install -g "cli-funnel@${CLI_FUNNEL_VERSION}" ${CLIS}

USER node
WORKDIR /workspace
ENTRYPOINT ["cli-funnel"]
# Listens on all interfaces inside the container. compose.yaml publishes the port on the tailnet address only.
CMD ["serve", "--host", "0.0.0.0", "--fs-root", "/workspace"]
