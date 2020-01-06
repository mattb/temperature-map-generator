const Promise = require("bluebird");
const AWS = require("aws-sdk"); // eslint-disable-line import/no-extraneous-dependencies
const chroma = require("chroma-js");
const fetch = require("isomorphic-fetch");

const d3 = require("d3-geo");
const FormData = require("form-data");
const util = require("util");
const Twitter = require("twitter");
const process = require("process");
require("dotenv-safe").config();
const fs = Promise.promisifyAll(require("fs"));
const imagemin = require("imagemin");
const imageminOptipng = require("imagemin-optipng");
const zlib = Promise.promisifyAll(require("zlib"));
const ua = require("universal-analytics");
const SunCalc = require("suncalc");
const monitoring = require("@google-cloud/monitoring");
const kriging = require("./kriging");
const get_water_polygons = require("./get_water");

const cToF = c => Math.round((c * 9.0) / 5.0 + 32);

const metricsGauge = metricDescriptor => {
  if (
    process.env.GOOGLE_PROJECT_ID &&
    fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ) {
    console.log("Metrics time!");
    const client = new monitoring.MetricServiceClient();
    const request = {
      name: client.projectPath(process.env.GOOGLE_PROJECT_ID),
      metricDescriptor
    };

    // Creates a custom metric descriptor
    const created = client
      .createMetricDescriptor(request)
      .then(results => {
        const descriptor = results[0];

        console.log("Created custom Metric:\n");
        console.log(`Name: ${descriptor.displayName}`);
        console.log(`Description: ${descriptor.description}`);
        console.log(`Type: ${descriptor.type}`);
        console.log(`Kind: ${descriptor.metricKind}`);
        console.log(`Value Type: ${descriptor.valueType}`);
        console.log(`Unit: ${descriptor.unit}`);
        console.log("Labels:");
        descriptor.labels.forEach(label => {
          console.log(
            `  ${label.key} (${label.valueType}) - ${label.description}`
          );
        });
      })
      .catch(err => {
        console.error("ERROR:", err);
      });
    return value => {
      const dataPoint = {
        interval: {
          endTime: {
            seconds: Date.now() / 1000
          }
        },
        value: {
          int64Value: value
        }
      };

      const timeSeriesData = {
        metric: {
          type: metricDescriptor.type
        },
        resource: {
          type: "global",
          labels: {
            project_id: process.env.GOOGLE_PROJECT_ID
          }
        },
        points: [dataPoint]
      };

      const tsRequest = {
        name: client.projectPath(process.env.GOOGLE_PROJECT_ID),
        timeSeries: [timeSeriesData]
      };

      created.then(() => {
        // Writes time series data
        client
          .createTimeSeries(tsRequest)
          .then(results => {
            console.log("Done writing time series data.", results[0]);
          })
          .catch(err => {
            console.error("ERROR:", err);
          });
      });
    };
  }
  return () => {};
};

const analytics = (() => {
  if (process.env.GOOGLE_ANALYTICS_ID) {
    const ga = ua(process.env.GOOGLE_ANALYTICS_ID);
    return {
      exception: e =>
        ga.exception(e, err => err && console.log("GA ERROR", err)),
      event: (a, b) =>
        ga.event(a, b, err => err && console.log("GA ERROR", err))
    };
  }
  return {
    exception: () => {},
    event: () => {}
  };
})();

const tweet = (png, data) => {
  if (process.env.CONFIG_TWEET !== "yes") {
    return;
  }
  const client = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
  });
  client.post("media/upload", { media: png }, (error, media) => {
    if (!error) {
      const status = {
        status: `Temperatures in San Francisco right now: ${Math.round(
          data.min_in_c
        )}C/${cToF(data.min_in_c)}F min, ${Math.round(
          data.average_in_c
        )}C/${cToF(data.average_in_c)}F average, ${Math.round(
          data.max_in_c
        )}C/${cToF(data.max_in_c)}F max`,
        media_ids: media.media_id_string // Pass the media id string
      };

      client.post("statuses/update", status, (updateError, _, response) => {
        if (!updateError) {
          console.log("Tweeted");
        } else {
          console.log(updateError, response);
        }
      });
    }
  });
};

const s3 = new AWS.S3();

AWS.config.getCredentials(err => {
  if (err) {
    console.log("Credentials error", err.stack);
  }
});

const gauge = metricsGauge({
  description: "Maps generated",
  displayName: "Maps generated",
  type: "custom.googleapis.com/maps",
  metricKind: "GAUGE",
  valueType: "INT64",
  labels: []
});

const s3Upload = (
  configData,
  summaryFilename,
  filenameBase,
  pngBuffer,
  gzipJson
) =>
  Promise.all([
    s3
      .putObject({
        Bucket: "tempmap",
        Key: `${filenameBase}.png`,
        Body: pngBuffer,
        ContentType: "image/png",
        ACL: "public-read"
      })
      .promise(),
    s3
      .putObject({
        Bucket: "tempmap",
        Key: `${summaryFilename}.json`,
        Body: gzipJson,
        ContentEncoding: "gzip",
        ContentType: "application/json",
        ACL: "public-read"
      })
      .promise(),
    s3
      .putObject({
        Bucket: "tempmap",
        Key: `${filenameBase}.json`,
        Body: gzipJson,
        ContentEncoding: "gzip",
        ContentType: "application/json",
        ACL: "public-read"
      })
      .promise()
  ])
    .then(() => {
      analytics.event("Upload", configData.filename);
      console.log(`${summaryFilename}: Uploaded`);
    })
    .catch(err => {
      analytics.exception(`${summaryFilename}: ${err.message}`);
      console.log("Upload error", err);
    });

const readConfig = configName =>
  fs.readFileAsync(`configs/${configName}.json`).then(f => JSON.parse(f));

const token = () => {
  const form = new FormData();
  form.append("grant_type", "refresh_token");
  form.append("refresh_token", process.env.NETATMO_REFRESH_TOKEN);
  form.append("client_id", process.env.NETATMO_CLIENT_ID);
  form.append("client_secret", process.env.NETATMO_CLIENT_SECRET);
  const url = util.format("%s/oauth2/token", process.env.NETATMO_BASE_URL);
  return fetch(url, {
    method: "POST",
    body: form
  })
    .then(result => result.json())
    .then(result => result.access_token);
};

const getDataModes = {
  rain: (accessToken, frame) => {
    const url = `${
      process.env.NETATMO_BASE_URL
    }/api/getpublicdata?access_token=${accessToken}&lat_ne=${
      frame.ne[0]
    }&lon_ne=${frame.ne[1]}&lat_sw=${frame.sw[0]}&lon_sw=${frame.sw[1]}`;
    return fetch(url)
      .then(r => r.json())
      .then(result => {
        const rains = [];
        if (result.status > 300) {
          const error = new Error(result.statusText);
          error.response = result;
          throw error;
        }
        result.body.forEach(r => {
          Object.values(r.measures).forEach(measure => {
            if ("rain_60min" in measure) {
              const ll = [r.place.location[0], r.place.location[1]];
              const px = ll;
              rains.push([px[0], px[1], measure.rain_60min]);
            }
          });
        });
        return rains;
      });
  },
  temperature: (accessToken, frame) => {
    const url = `${
      process.env.NETATMO_BASE_URL
    }/api/getpublicdata?access_token=${accessToken}&lat_ne=${
      frame.ne[0]
    }&lon_ne=${frame.ne[1]}&lat_sw=${frame.sw[0]}&lon_sw=${frame.sw[1]}`;
    console.log(`Accessing Netatmo API at ${url}`);
    return fetch(url)
      .then(r => r.json())
      .then(result => {
        const temps = [];
        if (result.status > 300) {
          const error = new Error(result.statusText);
          error.response = result;
          throw error;
        }
        if (!result.body) {
          const error = new Error("No body in Netatmo result");
          error.response = result;
          throw error;
        }
        result.body.forEach(r => {
          Object.values(r.measures).forEach(measure => {
            if ("type" in measure) {
              const idx = measure.type.indexOf("temperature");
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
  }
};

const getData = (mode, ...args) => getDataModes[mode](...args);

const colors = {
  temperature: chroma
    .scale("Spectral")
    .mode("lab")
    .domain([32, -10]),
  rain: chroma
    .scale(["#cbe6a3", "#05445c"])
    .mode("lab")
    .domain([0, 5])
};
const colorFor = (mode, c) => {
  if (mode === "temperature") {
    return colors.temperature(Math.round(c)).rgb();
  }
  return colors[mode](Math.round(c * 4) / 4.0).rgb();
};

const drawGeoJson = (context, geoJson, projection, fillStyle) => {
  const path = d3
    .geoPath()
    .projection(projection)
    .context(context);
  context.fillStyle = fillStyle; // eslint-disable-line no-param-reassign
  context.beginPath();
  path(geoJson);
  context.fill();
};

const trainKriging = (data, projection) => {
  const points = [];
  data.forEach(d => {
    const xy = projection([d[0], d[1]]);
    points.push([xy[0], xy[1], d[2]]);
  });

  const x = points.map(d => d[0]);
  const y = points.map(d => d[1]);
  const t = points.map(d => d[2]);
  const model = "exponential";
  const sigma2 = 0;
  const alpha = 100;
  return kriging.train(t, x, y, model, sigma2, alpha);
};

const makeProjection = (width, height, frame) =>
  d3.geoMercator().fitSize([width, height], {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [frame.sw[1], frame.sw[0]]
        }
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [frame.ne[1], frame.ne[0]]
        }
      }
    ]
  });

/*
console.log(
  proj([frame.sw[1], frame.ne[0]]).map(x => Math.round(x)),
  proj([frame.ne[1], frame.sw[0]]).map(x => Math.round(x))
);
*/

const generateMap = async (configName, accessToken, gaugeNumber) => {
  const modes = ["temperature", "rain"];
  const configData = await readConfig(configName);
  const { places, frame, width, height } = configData;

  const geoJson = await get_water_polygons(configName, {
    lon_min: frame.sw[1],
    lat_min: frame.sw[0],
    lon_max: frame.ne[1],
    lat_max: frame.ne[0]
  });

  return Promise.map(modes, async mode => {
    try {
      console.log("Generating", configName, mode);

      const data = await getData(mode, accessToken, frame);

      // require Canvas from optional dependencies so that claudia/lambda can parse it during upload without barfing
      // (the dependency is actually in the lambda layer) https://github.com/jwerre/node-canvas-lambda
      const { Canvas } = require("canvas"); // eslint-disable-line import/no-extraneous-dependencies, global-require
      const canvas = new Canvas(width, height);
      const context = canvas.getContext("2d");
      const proj = makeProjection(width, height, frame);
      const canvasData = context.getImageData(0, 0, width, height);

      const variogram = trainKriging(data, proj);
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
          const color = colorFor(mode, val);
          [
            canvasData.data[index],
            canvasData.data[index + 1],
            canvasData.data[index + 2]
          ] = color;
          canvasData.data[index + 3] = 255;
        }
      }
      if (process.env.CONFIG_SKIP_TEMPERATURES !== "yes") {
        context.putImageData(canvasData, 0, 0);
      }

      drawGeoJson(context, geoJson, proj, "lightblue");

      const suffix = mode === "temperature" ? "" : `-${mode}`;
      const summaryFilename = `${configData.filename}${suffix}`;
      const filenameBase = `${summaryFilename}-${new Date().toISOString()}`;

      const output = {
        frame,
        temperature_color_scale: Array.from(
          { length: 60 },
          (_, key) => key - 20
        ).map(i => [i, colorFor(mode, i)]),
        d3: {
          scale: proj.scale(),
          translate: proj.translate()
        },
        places: places.map(p => {
          const xy = proj([p.latlon[1], p.latlon[0]]);
          return {
            ...p,
            temp_in_c: kriging.predict(xy[0], xy[1], variogram).toFixed(1),
            x: xy[0].toFixed(0),
            y: xy[1].toFixed(1)
          };
        }),
        timestamp: new Date().toISOString(),
        pod: process.env.MY_POD_NAME,
        average_in_c: predictions.reduce((a, b) => a + b) / predictions.length,
        min_in_c: predictions.reduce((a, b) => Math.min(a, b)).toFixed(1),
        max_in_c: predictions.reduce((a, b) => Math.max(a, b)).toFixed(1),
        png: `${filenameBase}.png`,
        sun: SunCalc.getTimes(new Date(), frame.sw[0], frame.sw[1]),
        lambda: "yes"
      };

      const gzipJson = await zlib.gzipAsync(JSON.stringify(output, null, 2));
      const pngBuffer = await imagemin.buffer(canvas.toBuffer(), {
        use: [imageminOptipng()]
      });
      if (configName === "sf" && mode === "temperature") {
        tweet(pngBuffer, output);
      }
      if (process.env.CONFIG_S3_UPLOAD === "yes") {
        s3Upload(
          configData,
          summaryFilename,
          filenameBase,
          pngBuffer,
          gzipJson
        ).then(() => gauge(gaugeNumber));
      } else {
        Promise.all([
          fs.writeFileAsync(`output/${filenameBase}.png`, pngBuffer),
          fs.writeFileAsync(
            `output/${filenameBase}.json`,
            JSON.stringify(output, null, 2)
          )
        ]).then(() => console.log(`${configName}: Written files`));
      }
    } catch (e) {
      console.log("Error in", configName, mode, e);
    }
  });
};

const generate = async () => {
  const t = await token();
  let n = 0;
  return Promise.each(
    ["sf", "eastbay", "northbay", "southbay", "bayarea"],
    config => {
      n += 1;
      return generateMap(config, t, n);
    }
  );
};

module.exports = { generate };
