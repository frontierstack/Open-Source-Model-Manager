FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./
ENV PATH=/usr/local/bin:$PATH
RUN apt-get update && apt-get install -y python3 python3-pip jq && pip3 install --break-system-packages huggingface-hub psutil
RUN npm install
COPY . .
RUN npm run build

EXPOSE 3001

CMD [ "node", "server.js" ]