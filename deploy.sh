#!/bin/sh
eval $(docker-machine env temps)

export CONFIG_S3_UPLOAD=yes
export CONFIG_SCHEDULE=yes
export CONFIG_TWEET=yes

docker-compose up -d --build
