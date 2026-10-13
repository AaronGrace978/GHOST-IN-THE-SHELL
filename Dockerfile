FROM node:20-alpine

WORKDIR /sandbox

RUN apk add --no-cache git

COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src

CMD ["npx", "tsc", "--noEmit"]
