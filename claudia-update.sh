docker run -t -i -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -v $PWD:/claudia -v $HOME/.aws:/root/.aws --rm lambci/lambda:build-nodejs10.x /bin/bash -c "\
cd /claudia
rm -rf node_modules
npm install -g claudia
npm run claudia-update
"
