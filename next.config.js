/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
    resolveAlias: {
      fs: { browser: "./lib/browserEmptyModule.ts" },
      path: { browser: "./lib/browserEmptyModule.ts" },
      "ort.bundle.min.mjs": {
        browser: "./node_modules/onnxruntime-web/dist/ort.bundle.min.mjs",
      },
    },
  },

  serverExternalPackages: ["tesseract.js"],
};

module.exports = nextConfig;
