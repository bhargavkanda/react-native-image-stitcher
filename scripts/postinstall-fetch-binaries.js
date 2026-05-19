#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * postinstall-fetch-binaries.js — fetch OpenCV binaries matching this
 * package's version from GitHub Releases.
 *
 * Runs after `npm install` / `yarn install` in the consumer app.
 * Reads `package.json#version`, fetches the matching iOS xcframework
 * + Android per-ABI archives, extracts them into the expected
 * locations so `pod install` and `./gradlew` find them on the next
 * native build.
 *
 * The mechanism is fault-tolerant:
 *   - Already-on-disk binaries → skip fetch (matched by .opencv-fetched
 *     marker file recording the version).
 *   - Transient network failures → retry up to 3× with exponential
 *     backoff.
 *   - Unreachable GH Releases (e.g., offline install of a fresh
 *     package version) → exit cleanly with a warning + instructions
 *     to re-run `npm install` later.  This lets `npm install` itself
 *     succeed (the native build will fail later with a clear error,
 *     vs blocking the JS-only `npm install` step here).
 *
 * Env overrides:
 *   OPENCV_BINARY_BASE_URL — override the default GH Releases URL
 *                            (useful for internal mirrors).
 *   SKIP_OPENCV_FETCH=1     — bail out (used by CI builds where the
 *                              binaries are pre-staged manually).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const zlib = require('zlib');

const PKG = require(path.join(__dirname, '..', 'package.json'));
const VERSION = PKG.version;
const TAG = `v${VERSION}`;

// When this script is moved to the public lib repo, BASE_URL becomes
// `https://github.com/bhargav-kanda/react-native-image-stitcher/releases/download`.
// Until then (development in the monorepo), allow override via env.
const DEFAULT_BASE_URL =
  'https://github.com/bhargav-kanda/react-native-image-stitcher/releases/download';
const BASE_URL = process.env.OPENCV_BINARY_BASE_URL || DEFAULT_BASE_URL;

const PKG_ROOT = path.join(__dirname, '..');
const IOS_DEST = path.join(PKG_ROOT, 'ios', 'Frameworks');
const ANDROID_DEST = path.join(PKG_ROOT, 'android', 'src', 'main', 'jniLibs');
const MARKER = path.join(PKG_ROOT, '.opencv-fetched');

const IOS_ASSET = `RNImageStitcher-${TAG}-ios.zip`;
const ANDROID_ASSET = `RNImageStitcher-${TAG}-android.zip`;

function log(...args) {
  console.log('[react-native-image-stitcher postinstall]', ...args);
}

function warn(...args) {
  console.warn('[react-native-image-stitcher postinstall]', ...args);
}

function alreadyFetched() {
  try {
    const v = fs.readFileSync(MARKER, 'utf8').trim();
    return v === VERSION;
  } catch {
    return false;
  }
}

function markFetched() {
  fs.writeFileSync(MARKER, `${VERSION}\n`, 'utf8');
}

function downloadWithRedirects(url, destPath, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl, redirectsLeft) {
      const req = https.get(currentUrl, (res) => {
        // Follow 301 / 302 / 307.
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          return attempt(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(`HTTP ${res.statusCode} for ${currentUrl}`),
          );
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
        file.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy(new Error('Download timed out'));
      });
    }
    attempt(url, maxRedirects);
  });
}

async function downloadWithRetries(url, destPath) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await downloadWithRedirects(url, destPath);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const wait = 1000 * Math.pow(2, attempt - 1);
      warn(`Download failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      warn(`Retrying in ${wait} ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function unzip(zipPath, dest) {
  // `unzip` is available on every macOS and most Linux distros; we
  // use it directly so the script has no npm dep.
  execSync(`unzip -oq ${JSON.stringify(zipPath)} -d ${JSON.stringify(dest)}`);
}

async function main() {
  if (process.env.SKIP_OPENCV_FETCH === '1') {
    log('SKIP_OPENCV_FETCH=1 set — skipping.');
    return;
  }

  if (alreadyFetched()) {
    log(`OpenCV ${VERSION} already on disk; skipping fetch.`);
    return;
  }

  log(`Fetching OpenCV binaries for ${TAG}…`);
  log(`Base URL: ${BASE_URL}`);

  ensureDir(IOS_DEST);
  ensureDir(ANDROID_DEST);
  ensureDir(path.join(PKG_ROOT, '.tmp'));

  try {
    const iosZip = path.join(PKG_ROOT, '.tmp', IOS_ASSET);
    const androidZip = path.join(PKG_ROOT, '.tmp', ANDROID_ASSET);

    await Promise.all([
      downloadWithRetries(`${BASE_URL}/${TAG}/${IOS_ASSET}`, iosZip),
      downloadWithRetries(`${BASE_URL}/${TAG}/${ANDROID_ASSET}`, androidZip),
    ]);

    log('Extracting iOS xcframework…');
    unzip(iosZip, IOS_DEST);
    log('Extracting Android per-ABI binaries…');
    unzip(androidZip, ANDROID_DEST);

    markFetched();
    log('OpenCV binaries ready.');
  } catch (err) {
    warn(
      'Could not fetch OpenCV binaries.  This is non-fatal for now — '
        + '`npm install` succeeds.  Your next native build will fail '
        + 'with a clear error.  Recovery:',
    );
    warn(`  1. Verify ${BASE_URL}/${TAG}/${IOS_ASSET} is reachable.`);
    warn('  2. Re-run `npm install` once network is available.');
    warn(`Underlying error: ${err.message}`);
  }
}

main().catch((err) => {
  warn(`Unexpected error: ${err.message}`);
  // Exit code 0 — don't block `npm install` on a download failure.
  process.exit(0);
});
