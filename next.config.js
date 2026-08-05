/** @type {import('next').NextConfig} */
const nextConfig = {
  // jimp is pure JavaScript (no native bindings), so it needs no special
  // bundling configuration to work in Vercel's serverless functions -
  // that's specifically why it was chosen over sharp for this project.

  // A stray package.json/package-lock.json in the parent user directory
  // (C:\Users\ASUS) makes Next.js misdetect the workspace root, which
  // breaks Turbopack's React Client Manifest resolution. Pin it explicitly.
  turbopack: {
    root: __dirname,
  },

  // tesseract.js resolves its Node worker script (worker-script/node/index.js)
  // via a dynamic require() at runtime that bundlers can't statically
  // analyze. Marking it external tells Next.js to require() it straight
  // from node_modules instead of bundling it, so the real path resolves.
  serverExternalPackages: ["tesseract.js"],
};

module.exports = nextConfig;
