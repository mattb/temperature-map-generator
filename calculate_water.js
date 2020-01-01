const Promise = require("bluebird");
const fs = Promise.promisifyAll(require("fs"));
const get_water_polygons = require("./get_water");

const readConfig = configName =>
  fs.readFileAsync(`configs/${configName}.json`).then(f => JSON.parse(f));

const writePolygons = (configName, polygons) =>
  fs.writeFileAsync(
    `configs/${configName}_polygons.json`,
    JSON.stringify(polygons)
  );

const writeAll = () => {
  Promise.each(
    ["sf", "eastbay", "northbay", "southbay", "bayarea"],
    async configName => {
      const configData = await readConfig(configName);
      const { places, frame, width, height } = configData;
      writePolygons(
        configName,
        await get_water_polygons({
          lon_min: frame.sw[1],
          lat_min: frame.sw[0],
          lon_max: frame.ne[1],
          lat_max: frame.ne[0]
        })
      );
    }
  );
};

writeAll();
