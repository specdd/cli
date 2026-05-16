ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE}

ARG SPECDD_VERSION

LABEL org.opencontainers.image.title="SpecDD CLI" \
  org.opencontainers.image.description="CLI tool for working with SpecDD workflows" \
  org.opencontainers.image.url="https://specdd.ai" \
  org.opencontainers.image.source="https://github.com/specdd/cli" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="${SPECDD_VERSION}"

RUN test -n "${SPECDD_VERSION}" \
  && npm install --global --omit=dev --ignore-scripts --no-audit --no-fund "specdd@${SPECDD_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /workspace \
  && chown node:node /workspace

WORKDIR /workspace

USER node

ENTRYPOINT ["specdd"]
CMD ["--help"]
