# Official Puppeteer image: Chrome + all system libraries already installed
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Use the Chrome that ships in the image, don't download another one
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

WORKDIR /app
COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev

COPY --chown=pptruser:pptruser . .
RUN mkdir -p generated

EXPOSE 10000
CMD ["node", "server.js"]
