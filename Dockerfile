FROM node:20-bookworm
WORKDIR /app
COPY package.json .
RUN npm install && npx playwright install chromium --with-deps
COPY . .
CMD ["node", "fetch-expireds.js"]
