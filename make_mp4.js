const Promise = require('bluebird');
const AWS = require('aws-sdk');
const fetch = require('isomorphic-fetch');
const fs = Promise.promisifyAll(require('fs'));
const moment = require('moment');
const exec = require('child_process').exec;

const pad = (n, width = 3, z = 0) =>
  (String(z).repeat(width) + String(n)).slice(String(n).length);

const s3 = (() => {
  const credentials = new AWS.Credentials(
    process.env.AWS_ACCESS_KEY_ID,
    process.env.AWS_SECRET_ACCESS_KEY
  );
  const config = new AWS.Config();
  config.update({ credentials });
  return new AWS.S3(config);
})();

s3
  .listObjectsV2({
    Prefix: 'temps-',
    Bucket: 'tempmap',
    StartAfter: `temps-${moment().subtract(1, 'd').toISOString()}.png`
  })
  .promise()
  .then(i => i.Contents.filter(k => k.Key.endsWith('.png')).map(k => k.Key))
  .then(pngs =>
    Promise.all(
      pngs.map((p, i) =>
        fetch(`http://tempmap.s3.amazonaws.com/${p}`)
          .then(png => png.buffer())
          .then(data => fs.writeFileAsync(`frame${pad(i, 3)}.png`, data))
          .then(() => `frame${pad(i, 3)}.png`)
      )
    )
  )
  .then(pngs => {
    exec(
      'ffmpeg -s 750x1334 -r 6 -f image2 -i frame%03d.png -vcodec libx264 -crf 25  -pix_fmt yuv420p out.mp4',
      () => {
        Promise.all(pngs.map(p => fs.unlinkAsync(p))).then(() =>
          console.log('DONE')
        );
      }
    );
  });
