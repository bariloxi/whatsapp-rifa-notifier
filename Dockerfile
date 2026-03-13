FROM node:20-slim

# Install system dependencies for Puppeteer and Chrome
RUN apt-get update && apt-get install -y \
    wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy and install only backend dependencies (Lighter!)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the files (including the pre-built frontend/dist)
COPY . .

# Environment variables
ENV PORT=3001
ENV HEADLESS=true
ENV CHROME_PATH=/usr/bin/google-chrome-stable

EXPOSE 3001

CMD ["node", "server.js"]
