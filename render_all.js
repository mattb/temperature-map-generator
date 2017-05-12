const get_water_polygons = require('./get_water');
const AWS = require('aws-sdk');
const kriging = require('./kriging');
const chroma = require('chroma-js');
const fetch = require('isomorphic-fetch');
const d3 = Object.assign({}, require('d3-geo'), require('d3-array'));
const Canvas = require('canvas');
const FormData = require('form-data');
const util = require('util');
const Twitter = require('twitter');
const schedule = require('node-schedule');
const process = require('process');
const fs = require('fs');

const tweet = png => {
  if (process.env.CONFIG_TWEET !== 'yes') {
    return;
  }
  const client = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
  });
  client.post('media/upload', { media: png }, (error, media) => {
    if (!error) {
      const status = {
        status: 'Temperatures in San Francisco right now',
        media_ids: media.media_id_string // Pass the media id string
      };

      client.post(
        'statuses/update',
        status,
        (updateError, updateTweet, response) => {
          if (!updateError) {
            console.log('Tweeted');
          } else {
            console.log(updateError, response);
          }
        }
      );
    }
  });
};

const width = 750;
const height = 1334;

const ne = [37.870226, -122.358991];
const sw = [37.632867, -122.527905];

const s3 = (() => {
  const credentials = new AWS.Credentials(
    process.env.AWS_ACCESS_KEY_ID,
    process.env.AWS_SECRET_ACCESS_KEY
  );
  const config = new AWS.Config();
  config.update({ credentials });
  return new AWS.S3(config);
})();

const token = () => {
  const form = new FormData();
  form.append('grant_type', 'refresh_token');
  form.append('refresh_token', process.env.NETATMO_REFRESH_TOKEN);
  form.append('client_id', process.env.NETATMO_CLIENT_ID);
  form.append('client_secret', process.env.NETATMO_CLIENT_SECRET);
  const url = util.format('%s/oauth2/token', process.env.NETATMO_BASE_URL);
  return fetch(url, {
    method: 'POST',
    body: form
  })
    .then(result => result.json())
    .then(result => result.access_token);
};

const getData = accessToken => {
  const url = `https://dev.netatmo.com/api/getpublicdata?access_token=${accessToken}&lat_ne=${ne[0]}&lon_ne=${ne[1]}&lat_sw=${sw[0]}&lon_sw=${sw[1]}`;
  return fetch(url).then(r => r.json()).then(result => {
    const temps = [];
    result.body.forEach(r => {
      Object.values(r.measures).forEach(measure => {
        if ('type' in measure) {
          const idx = measure.type.indexOf('temperature');
          if (idx !== -1) {
            const ll = [r.place.location[0], r.place.location[1]];
            const px = ll;
            temps.push([px[0], px[1], Object.values(measure.res)[0][idx]]);
          }
        }
      });
    });
    return temps;
  });
};

const generateMap = () => {
  const colors = chroma
    .scale('Spectral')
    .mode('lab')
    .colors(120, 'rgb')
    .reverse();

  get_water_polygons({
    lon_min: sw[1],
    lat_min: sw[0],
    lon_max: ne[1],
    lat_max: ne[0]
  }).then(json => {
    const canvas = new Canvas(width, height);
    const context = canvas.getContext('2d');
    const proj = d3.geoMercator();
    proj.fitSize([width, height], json);
    const path = d3.geoPath().projection(proj).context(context);

    token().then(t => getData(t)).then(data => {
      const points = [];
      data.forEach(d => {
        const xy = proj([d[0], d[1]]);
        points.push([xy[0], xy[1], d[2]]);
      });

      const x = points.map(d => d[0]);
      const y = points.map(d => d[1]);
      const t = points.map(d => d[2]);
      const model = 'exponential';
      const sigma2 = 0;
      const alpha = 100;
      const variogram = kriging.train(t, x, y, model, sigma2, alpha);

      const output = {
        points: []
      };
      const canvasData = context.getImageData(0, 0, width, height);
      for (let ypos = 0; ypos < height; ypos += 1) {
        const line = [];
        for (let xpos = 0; xpos < height; xpos += 1) {
          const val = kriging.predict(xpos, ypos, variogram);
          if (xpos % 10 === 0 && ypos % 10 === 0) {
            line.push({
              ll: proj.invert([xpos, ypos]).map(l => l.toFixed(4)),
              t: val.toFixed(1)
            });
          }
          const index = (xpos + ypos * width) * 4;
          const color = colors[Math.floor(2 * (val + 20))];
          canvasData.data[index] = color[0];
          canvasData.data[index + 1] = color[1];
          canvasData.data[index + 2] = color[2];
          canvasData.data[index + 3] = 255;
        }
        if (line.length > 0) {
          output.points.push(line);
        }
      }
      context.putImageData(canvasData, 0, 0);

      context.fillStyle = 'lightblue';
      context.beginPath();
      path(json);
      context.fill();

      tweet(canvas.toBuffer());
      const filenameBase = `temps-${new Date().toISOString()}`;
      if (process.env.CONFIG_S3_UPLOAD === 'yes') {
        const put1 = s3
          .putObject({
            Bucket: 'tempmap',
            Key: `${filenameBase}.png`,
            Body: canvas.toBuffer(),
            ContentType: 'image/png',
            ACL: 'public-read'
          })
          .promise();
        const put2 = s3
          .putObject({
            Bucket: 'tempmap',
            Key: `${filenameBase}.json`,
            Body: JSON.stringify(output, null, 2),
            ContentType: 'application/json',
            ACL: 'public-read'
          })
          .promise();
        Promise.all([put1, put2])
          .then(() => console.log('Uploaded'))
          .catch(err => console.log('Upload error', err));
      } else {
        fs.writeFileSync('out.png', canvas.toBuffer());
        fs.writeFileSync('out.json', JSON.stringify(output, null, 2));
        console.log('Written files');
      }
    });
  });
};

if (process.env.CONFIG_SCHEDULE === 'yes') {
  schedule.scheduleJob('0 * * * *', () => {
    console.log('Generating...');
    generateMap();
  });
} else {
  console.log('Generating...');
  generateMap();
}
