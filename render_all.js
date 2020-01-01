const schedule = require("node-schedule");
const process = require("process");
require("dotenv-safe").config();
const { generate } = require("./generator");

if (process.env.CONFIG_SCHEDULE === "yes") {
  console.log("Running in scheduler mode");
  schedule.scheduleJob("0 * * * *", () => {
    generate();
  });
} else {
  console.log("Running in immediate mode");
  generate();
}
