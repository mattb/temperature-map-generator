FROM node:8

RUN apt-get update && apt-get install -y libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev build-essential g++

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package-lock.json package.json /usr/src/app/
RUN npm install

COPY . /usr/src/app

CMD [ "npm", "start" ]
