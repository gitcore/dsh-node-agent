/**
 * Build the client half into the CJS bundle the web shell expects:
 * window.__ModuleLoader__.load({ id, factory }) with react / @deepseek-ai/*
 * left external (resolved by the browser module table at runtime).
 */
import { build } from "esbuild";

const banner = `window.__ModuleLoader__.load({ id: "dsh-node-agent", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;

const footer = `
return module.exports;
} });
`;

await build({
  entryPoints: ["src/client.tsx"],
  outfile: "lib/client.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  external: ["@deepseek-ai/*", "react", "react/jsx-runtime", "react-dom"],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: "info",
});

console.log("client bundle written to lib/client.js");
