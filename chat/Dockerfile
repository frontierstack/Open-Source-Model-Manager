FROM node:20-alpine

WORKDIR /usr/src/app

# Install openssl for generating self-signed certificates
RUN apk add --no-cache openssl

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Build the React app
RUN npm run build

# Expose port
EXPOSE 3002

# Start the server
CMD ["node", "server.js"]
