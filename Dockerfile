# docker-logentries
#
# VERSION 0.2.0

FROM node:4.8.2
MAINTAINER Rapid 7 - Logentries <support@logentries.com>

WORKDIR /usr/src/app
COPY package.json package.json
RUN npm install --production
COPY index.js /usr/src/app/index.js

ENTRYPOINT ["/usr/src/app/index.js"]
CMD []
