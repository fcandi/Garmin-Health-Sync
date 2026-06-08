import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json,
// but only for stable releases (versions.json maps store versions → minAppVersion).
// Prerelease tags (x.y.z-beta.N) must never land here; skip anything with a `-`.
const isPrerelease = targetVersion.includes("-");
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!isPrerelease && !(targetVersion in versions)) {
    versions[targetVersion] = minAppVersion;
    writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
