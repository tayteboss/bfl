# Matches the locally tested Node SQLite API. Pin the resolved image digest in
# deployment approval; do not upgrade Node/SQLite without persistence tests.
FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c
WORKDIR /app
COPY backend/ ./backend/
COPY jobs/ ./jobs/
COPY uploads/ ./uploads/
COPY orders/ ./orders/
COPY configuration/config.mjs configuration/schema.mjs configuration/shopify.mjs configuration/engineering.mjs configuration/engineering-job.mjs configuration/engineering-operator.mjs ./configuration/
COPY pricing/prepare.mjs pricing/product-catalog.mjs pricing/compact-catalog.mjs pricing/lab-variant-catalog.mjs ./pricing/
COPY shipping/packing.mjs shipping/quote.mjs shipping/full-product.mjs ./shipping/
COPY shipping/shippo.mjs ./shipping/
COPY carrier/ ./carrier/
COPY checkout/authority.js checkout/projector.mjs checkout/shopify.mjs ./checkout/
COPY checkout/storefront.mjs checkout/current-cart.graphql checkout/refresh-ledger.mjs checkout/refresh.mjs ./checkout/
COPY checkout/cart-binding.mjs checkout/composition.mjs checkout/diagnostic-publication.mjs ./checkout/
COPY checkout/owned-cart.mjs checkout/cart-capability.mjs checkout/proxy-context.mjs ./checkout/
COPY checkout/quantity-signature.js checkout/lease.mjs checkout/eligibility-projector.mjs checkout/job-eligibility.mjs checkout/prepared-ledger.mjs checkout/prepared-publication.mjs checkout/prepared-limits.mjs ./checkout/
COPY checkout/staging-cart.mjs checkout/staging-grants.mjs checkout/staging-prepared-publication.mjs ./checkout/
COPY package.json ./package.json
RUN chmod -R a+rX /app && mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV NODE_ENV=production BFL_DATA_DIR=/data WEB_CONCURRENCY=1
EXPOSE 6076
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:6076/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "backend/main.mjs"]
CMD ["serve"]
