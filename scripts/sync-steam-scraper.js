// Points the scheduled Steam scraper Machine at the image the web app is running,
// creating the Machine if it doesn't exist. `fly deploy` only updates Machines in
// its process groups, so without this the scraper keeps running whatever image it
// was created with. `npm run deploy` runs this after every deploy.

const { execFileSync } = require("child_process");

const APP = "mtgtruther";
const NAME = "steam-scraper";
const SCHEDULE = "weekly";
const COMMAND = ["node", "steamScrape.js", "--auto"];

const fly = (...args) =>
  execFileSync("flyctl", [...args, "-a", APP], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const machines = JSON.parse(fly("machine", "list", "--json"));
const web = machines.find((m) => m.config.metadata && m.config.metadata.fly_process_group === "app");
if (!web) throw new Error(`No web Machine found in ${APP}; deploy the app first.`);

const image = web.config.image;
const scraper = machines.find((m) => m.name === NAME);
// Fly pins the scraper's image to a digest (tag@sha256:...), so compare tags only.
const tag = (ref) => ref.split("@")[0];

if (!scraper) {
  // A new scheduled Machine runs once immediately, then on schedule.
  fly("machine", "run", image, "--name", NAME, "--region", web.region, "--schedule", SCHEDULE, "--restart", "no", "--", ...COMMAND);
  console.log(`Created ${NAME} (${SCHEDULE}) on ${image}`);
} else if (tag(scraper.config.image) === tag(image) && scraper.config.schedule === SCHEDULE) {
  console.log(`${NAME} is already on ${image} (${SCHEDULE})`);
} else {
  fly("machine", "update", scraper.id, "--image", image, "--schedule", SCHEDULE, "--restart", "no", "--skip-start", "--yes");
  console.log(`Updated ${NAME} to ${image} (${SCHEDULE})`);
}
