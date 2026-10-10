# Build from this application's directory. Only public configuration enters the build.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN NODE_OPTIONS=--max-old-space-size=384 npm ci --maxsockets=4 --no-audit --no-fund

FROM dependencies AS builder
# Next.js compilation needs about 3 GB of heap. Lower it only if the build
# host has less memory, and expect an out-of-memory failure below about 2 GB.
ARG BILLR_BUILD_HEAP_MB=3072
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
COPY . .
RUN BILLR_CONTAINER_BUILD=true NODE_OPTIONS=--max-old-space-size=${BILLR_BUILD_HEAP_MB} npm run build -- --webpack

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 BILLR_CONTAINER=true
WORKDIR /app
RUN groupadd --system --gid 1001 billr && useradd --system --uid 1001 --gid billr billr
COPY --from=builder --chown=billr:billr /app/.next/standalone ./
COPY --from=builder --chown=billr:billr /app/.next/static ./.next/static
COPY --from=builder --chown=billr:billr /app/public ./public
COPY --from=builder /app/scripts/validate-config.mjs ./scripts/validate-config.mjs
# Validator is executed without dotenv in the standalone image; Compose supplies env.
RUN sed -i '/import dotenv/d; /dotenv.config/d' scripts/validate-config.mjs
USER billr
EXPOSE 3000
CMD ["sh", "-c", "node scripts/validate-config.mjs && exec node server.js"]
