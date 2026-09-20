const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}

const referenceVersion = argumentsByName.get("--reference");
const baseUrl = new URL(argumentsByName.get("--base-url") ?? "https://staging.artifactpass.com");

if (!referenceVersion || !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(referenceVersion)) {
  throw new Error("--reference must name an exact ArtifactPass RC version");
}
if (baseUrl.protocol !== "https:") throw new Error("staging verification requires HTTPS");

const request = async (path) => fetch(new URL(path, baseUrl), { redirect: "manual" });
const healthResponse = await request("/health");
if (!healthResponse.ok) throw new Error(`Staging health failed (${healthResponse.status})`);
const health = await healthResponse.json();
if (
  health.status !== "ok" ||
  health.service !== "lordebuilds.artifacts.share" ||
  health.human_auth_mode !== "artifactpass" ||
  health.authentication_configured !== true
) {
  throw new Error("Staging health does not report a ready authenticated ArtifactPass service");
}

const homepageResponse = await request("/");
if (!homepageResponse.ok) throw new Error(`Staging homepage failed (${homepageResponse.status})`);
const homepage = await homepageResponse.text();
if (!homepage.includes(`artifactpass@${referenceVersion}`)) {
  throw new Error(`Staging is not serving artifactpass@${referenceVersion}`);
}

const uploadResponse = await request("/upload");
const uploadLocation = uploadResponse.headers.get("location");
if (
  ![302, 303, 307].includes(uploadResponse.status) ||
  uploadLocation === null ||
  new URL(uploadLocation, baseUrl).pathname !== "/auth/sign-in"
) {
  throw new Error("Staging upload is not protected by ArtifactPass sign-in");
}

for (const [provider, hostname] of [["google", "accounts.google.com"], ["github", "github.com"]]) {
  const response = await request(`/auth/login/${provider}?return_to=%2Fupload`);
  const location = response.headers.get("location");
  if (![302, 303, 307].includes(response.status) || location === null || new URL(location).hostname !== hostname) {
    throw new Error(`Staging ${provider} OAuth start is not ready`);
  }
}

process.stdout.write(`Staging is healthy and serving the qualified artifactpass@${referenceVersion} RC.\n`);
