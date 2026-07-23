FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    xvfb \
    x11vnc \
    fluxbox \
    dbus-x11 \
    ffmpeg \
    python3 \
    python3-pip \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install Python speech recognition
RUN pip3 install --break-system-packages SpeechRecognition

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_PATH=/usr/bin/chromium

# Expose ports
EXPOSE 8080
EXPOSE 5900

# Start command
CMD ["sh", "scripts/start.sh"]
