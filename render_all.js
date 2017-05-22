const Promise = require('bluebird');
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
const fs = Promise.promisifyAll(require('fs'));
const imagemin = require('imagemin');
const imageminOptipng = require('imagemin-optipng');
const zlib = Promise.promisifyAll(require('zlib'));

const cToF = c => Math.round(c * 9.0 / 5.0 + 32);

const tweet = (png, data) => {
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
        status: `Temperatures in San Francisco right now: ${Math.round(data.min_in_c)}C/${cToF(data.min_in_c)}F min, ${Math.round(data.average_in_c)}C/${cToF(data.average_in_c)}F average, ${Math.round(data.max_in_c)}C/${cToF(data.max_in_c)}F max`,
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

const readConfig = () => fs.readFileAsync('eastbay.json').then(f => JSON.parse(f));

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

const getData = (accessToken, frame) => {
  const url = `https://dev.netatmo.com/api/getpublicdata?access_token=${accessToken}&lat_ne=${frame.ne[0]}&lon_ne=${frame.ne[1]}&lat_sw=${frame.sw[0]}&lon_sw=${frame.sw[1]}`;
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
    const allTemps = temps.map(t => t[2]);
    allTemps.sort((a, b) => a - b);
    const upperCutoff = allTemps[Math.round(allTemps.length * 0.96)];
    return temps.filter(t => t[2] < upperCutoff);
  });
};

const colors = chroma.scale('Spectral').mode('lab').domain([32, -10]);
const colorForTemperature = c => colors(Math.round(c)).rgb();

const generateMap = () => {
  readConfig().then(configData => {
    const { places, frame, width, height } = configData;
    get_water_polygons({
      lon_min: frame.sw[1],
      lat_min: frame.sw[0],
      lon_max: frame.ne[1],
      lat_max: frame.ne[0]
    }).then(json => {
      const canvas = new Canvas(width, height);
      const context = canvas.getContext('2d');
      const proj = d3.geoMercator();
      proj.fitSize([width, height], json);
      const path = d3.geoPath().projection(proj).context(context);

      token().then(t => getData(t, frame)).then(data => {
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
          temperature_color_scale: Array.from(
            { length: 60 },
            (_, key) => key - 20
          ).map(i => [i, colorForTemperature(i)]),
          d3: {
            scale: proj.scale(),
            translate: proj.translate()
          },
          // points: [],
          places: places.map(p => {
            const xy = proj([p.latlon[1], p.latlon[0]]);
            return Object.assign({}, p, {
              temp_in_c: kriging.predict(xy[0], xy[1], variogram).toFixed(1),
              x: xy[0].toFixed(0),
              y: xy[1].toFixed(1)
            });
          })
        };
        const canvasData = context.getImageData(0, 0, width, height);
        const predictions = [];
        for (let ypos = 0; ypos < height; ypos += 1) {
          const line = [];
          for (let xpos = 0; xpos < height; xpos += 1) {
            const val = kriging.predict(xpos, ypos, variogram);
            predictions.push(val);
            if (xpos % 10 === 0 && ypos % 10 === 0) {
              line.push({
                ll: proj.invert([xpos, ypos]).map(l => l.toFixed(4)),
                t: val.toFixed(1)
              });
            }
            const index = (xpos + ypos * width) * 4;
            const color = colorForTemperature(val);
            canvasData.data[index] = color[0];
            canvasData.data[index + 1] = color[1];
            canvasData.data[index + 2] = color[2];
            canvasData.data[index + 3] = 255;
          }
          /* if (line.length > 0) {
            output.points.push(line);
          }*/
        }
        context.putImageData(canvasData, 0, 0);

        output.timestamp = new Date().toISOString();
        output.average_in_c =
          predictions.reduce((a, b) => a + b) / predictions.length;
        output.min_in_c = predictions
          .reduce((a, b) => Math.min(a, b))
          .toFixed(1);
        output.max_in_c = predictions
          .reduce((a, b) => Math.max(a, b))
          .toFixed(1);

        context.fillStyle = 'lightblue';
        context.beginPath();
        path(json);
        context.fill();

        const filenameBase = `temps-${new Date().toISOString()}`;
        output.png = `${filenameBase}.png`;
        zlib.gzipAsync(JSON.stringify(output, null, 2)).then(gzipJson => {
          imagemin
            .buffer(canvas.toBuffer(), { use: [imageminOptipng()] })
            .then(pngBuffer => {
              tweet(pngBuffer, output);
              if (process.env.CONFIG_S3_UPLOAD === 'yes') {
                Promise.all([
                  s3
                    .putObject({
                      Bucket: 'tempmap',
                      Key: 'temps.png',
                      Body: pngBuffer,
                      ContentType: 'image/png',
                      ACL: 'public-read'
                    })
                    .promise(),
                  s3
                    .putObject({
                      Bucket: 'tempmap',
                      Key: `${filenameBase}.png`,
                      Body: pngBuffer,
                      ContentType: 'image/png',
                      ACL: 'public-read'
                    })
                    .promise(),
                  s3
                    .putObject({
                      Bucket: 'tempmap',
                      Key: 'temps.json',
                      Body: gzipJson,
                      ContentEncoding: 'gzip',
                      ContentType: 'application/json',
                      ACL: 'public-read'
                    })
                    .promise(),
                  s3
                    .putObject({
                      Bucket: 'tempmap',
                      Key: `${filenameBase}.json`,
                      Body: gzipJson,
                      ContentEncoding: 'gzip',
                      ContentType: 'application/json',
                      ACL: 'public-read'
                    })
                    .promise()
                ])
                  .then(() => console.log('Uploaded'))
                  .catch(err => console.log('Upload error', err));
              } else {
                Promise.all([
                  fs.writeFileAsync('out.png', pngBuffer),
                  fs.writeFileAsync('out.json', JSON.stringify(output, null, 2))
                ]).then(() => console.log('Written files'));
              }
            });
        });
      });
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
