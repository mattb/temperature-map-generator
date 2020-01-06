#!/bin/sh
eval $(docker-machine env temps)

docker-compose logs -f
