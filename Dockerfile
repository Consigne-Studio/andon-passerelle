FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /donnees && chown node:node /donnees
USER node
WORKDIR /donnees
ENTRYPOINT ["node", "/app/src/index.js"]
CMD ["/donnees/passerelle.json"]
