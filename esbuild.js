const esbuild = require("esbuild");

const args = process.argv.slice(2);
const isWatch = args.includes("--watch");
const isProduction = args.includes("--production") || process.env.NODE_ENV === "production";

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  // @aws-sdk/client-s3 is an optional dynamic require inside unzipper (dependency of @clangd/install)
  external: ["vscode", "@aws-sdk/client-s3"],
  alias: {
    punycode: require.resolve("punycode/"),
    "readable-stream": "stream"
  },
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: "info"
};

async function main() {
  // Ensure media assets are copied to dist/media
  const fs = require('fs');
  const path = require('path');
  const srcMedia = path.join(__dirname, 'src', 'webview', 'media');
  const distMedia = path.join(__dirname, 'dist', 'media');
  if (fs.existsSync(srcMedia)) {
    fs.mkdirSync(distMedia, { recursive: true });
    fs.cpSync(srcMedia, distMedia, { recursive: true });
  }

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log("Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
