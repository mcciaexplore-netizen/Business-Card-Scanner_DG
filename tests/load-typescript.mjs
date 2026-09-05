import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Execute the actual TypeScript implementation with explicit service doubles.
// No production dependencies or source files are rewritten for tests.
export function loadTypeScript(path, overrides = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const output = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    function localRequire(specifier) {
      if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const target = specifier.startsWith("@/") ? resolve(root, specifier.slice(2)) : resolve(dirname(filename), specifier);
        return load(target.endsWith(".ts") ? target : target + ".ts");
      }
      return require(specifier);
    }
    new Function("require", "module", "exports", output)(localRequire, module, module.exports);
    return module.exports;
  }
  return load(resolve(root, path));
}
