const process = require("process");
const Promise = require("bluebird");
const pg = require("pg-promise");
const fs = Promise.promisifyAll(require("fs"));

const pgp = pg({ promiseLib: Promise });
const connectionString = process.env.POSTGRES_CONNECTION_STRING;
const db = pgp(connectionString);

const db_water_polygons = (configName, query) =>
  db
    .any(
      "SELECT ST_AsGeoJSON(ST_Intersection(water_polygons.wkb_geometry, ST_MakeEnvelope(${lon_min}, ${lat_min}, ${lon_max}, ${lat_max}, 4326))) AS geojson FROM water_polygons WHERE water_polygons.wkb_geometry && ST_MakeEnvelope(${lon_min}, ${lat_min}, ${lon_max}, ${lat_max}, 4326);", // eslint-disable-line no-template-curly-in-string
      query
    )
    .then(rows => ({
      type: "GeometryCollection",
      geometries: rows.map(d => JSON.parse(d.geojson))
    }));

const water_polygons = (configName, query) =>
  fs
    .readFileAsync(`configs/${configName}_polygons.json`)
    .then(JSON.parse)
    .catch(() => db_water_polygons(configName, query));

module.exports = water_polygons;
