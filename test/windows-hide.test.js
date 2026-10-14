import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  createCopilotCliAmbientContextScript,
  createServerSpawnOptions,
  listServerConnections,
  windowsBrowserArgs,
} from "../src/cli.js";

// On Windows every child process without windowsHide opens a console window. Each child-process
// call in the repo's JavaScript must pass windowsHide: true in its options object.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_DIRS = ["bin", "src", "scripts", "test"];
const CHILD_PROCESS_MODULES = new Set(["node:child_process", "child_process", "cross-spawn"]);
const CHILD_PROCESS_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
  "sync",
]);
// Helpers whose returned options include windowsHide. The unit tests below check each one.
const OPTIONS_HELPERS = new Set(["createServerSpawnOptions"]);

function listJsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === "node_modules") return [];
    if (statSync(full).isDirectory()) return listJsFiles(full);
    return /\.(?:c|m)?js$/.test(entry) ? [full] : [];
  });
}

// Returns the child-process bindings of a file: local name -> member name, or null when the
// local name is the module itself (a namespace import, or cross-spawn's default callable).
function collectChildProcessBindings(sourceFile) {
  const bindings = new Map();
  const moduleName = (node) => node.getText(sourceFile).replace(/^["']|["']$/g, "");
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && CHILD_PROCESS_MODULES.has(moduleName(node.moduleSpecifier))) {
      const clause = node.importClause;
      if (clause?.name) bindings.set(clause.name.text, null);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.set(clause.namedBindings.name.text, null);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          bindings.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      /["'](?:node:)?child_process["']|["']cross-spawn["']/.test(node.initializer.getText(sourceFile))
    ) {
      if (ts.isIdentifier(node.name)) bindings.set(node.name.text, null);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const local = element.name;
          const imported = element.propertyName ?? local;
          if (ts.isIdentifier(local) && ts.isIdentifier(imported)) bindings.set(local.text, imported.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  collectAliases(sourceFile, bindings);
  return bindings;
}

// Resolves an expression to the child-process value it names: a function name, null for the
// module itself, or undefined when it is not child-process code. promisify(fn) keeps fn's value.
function resolveChildProcessValue(expression, bindings) {
  if (ts.isParenthesizedExpression(expression)) return resolveChildProcessValue(expression.expression, bindings);
  if (ts.isIdentifier(expression)) return bindings.get(expression.text);
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const isModule = bindings.get(expression.expression.text) === null;
    return isModule && CHILD_PROCESS_FUNCTIONS.has(expression.name.text) ? expression.name.text : undefined;
  }
  if (ts.isCallExpression(expression) && isPromisifyCallee(expression.expression)) {
    const [first] = expression.arguments;
    const value = first ? resolveChildProcessValue(first, bindings) : undefined;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function isPromisifyCallee(callee) {
  if (ts.isIdentifier(callee)) return callee.text === "promisify";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "promisify";
}

// Binds names that hold a child-process value: `const run = spawnSync`, a default parameter or
// destructuring default (`{ run = spawnSync }`), an assignment, and promisify(...) of any of
// these. Two passes let an alias of an alias resolve. Bindings are file-wide and by name.
function collectAliases(sourceFile, bindings) {
  const bindAlias = (name, expression) => {
    if (!ts.isIdentifier(name) || !expression) return;
    const value = resolveChildProcessValue(expression, bindings);
    if (value !== undefined) bindings.set(name.text, value);
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) {
        bindAlias(node.name, node.initializer);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        bindAlias(node.left, node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function hasWindowsHide(call) {
  return call.arguments.some((argument) => {
    if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)) {
      return OPTIONS_HELPERS.has(argument.expression.text);
    }
    return (
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "windowsHide" &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword,
      )
    );
  });
}

// Returns one entry per child-process call that does not pass windowsHide: true.
export function findWindowsHideViolations(source, fileName = "input.js") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bindings = collectChildProcessBindings(sourceFile);
  const violations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name = null;
      if (ts.isIdentifier(callee) && bindings.has(callee.text)) {
        const member = bindings.get(callee.text);
        if (member === null || CHILD_PROCESS_FUNCTIONS.has(member)) name = member ?? callee.text;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bindings.get(callee.expression.text) === null &&
        CHILD_PROCESS_FUNCTIONS.has(callee.name.text)
      ) {
        name = callee.name.text;
      }
      if (name !== null && !hasWindowsHide(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ line: line + 1, call: callee.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

test("every child-process call in bin, src, scripts, and test passes windowsHide: true", () => {
  const violations = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of listJsFiles(path.join(REPO_ROOT, dir))) {
      const source = readFileSync(file, "utf8");
      for (const violation of findWindowsHideViolations(source, file)) {
        violations.push(
          `${path.relative(REPO_ROOT, file)}:${violation.line} ${violation.call}(...) lacks windowsHide: true`,
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the windowsHide scanner flags unhidden calls and accepts hidden ones", () => {
  const source = `
    import { spawn, spawnSync } from "node:child_process";
    import * as cp from "node:child_process";
    import crossSpawn from "cross-spawn";
    const { exec } = require("node:child_process");
    spawn("a", []);
    spawnSync("b", [], { encoding: "utf8" });
    spawn("c", [], { windowsHide: true });
    spawn("d", [], createServerSpawnOptions());
    cp.execFile("e", [], { windowsHide: false });
    crossSpawn.sync("f", []);
    exec("g");
    const pattern = /x/;
    pattern.exec("text");
  `;
  assert.deepEqual(
    findWindowsHideViolations(source).map((violation) => violation.call),
    ["spawn", "spawnSync", "cp.execFile", "crossSpawn.sync", "exec"],
  );
});

test("the windowsHide scanner follows child-process functions through aliases", () => {
  const source = `
    import * as cp from "node:child_process";
    import * as util from "node:util";
    import { execFile, spawn, spawnSync } from "node:child_process";
    import { promisify } from "node:util";
    const run = spawnSync;
    run("a", []);
    const execFileAsync = promisify(execFile);
    await execFileAsync("b", []);
    const hiddenRun = promisify(execFile);
    await hiddenRun("c", [], { windowsHide: true });
    const viaNamespace = util.promisify(cp.execFile);
    await viaNamespace("d", []);
    function list(port, { run: runner = spawnSync } = {}) {
      runner("e", []);
    }
    function withDefault(launch = spawn) {
      launch("f", []);
    }
    let assigned;
    assigned = spawn;
    assigned("g", []);
    const chained = assigned;
    chained("h", []);
    const hiddenAlias = spawnSync;
    hiddenAlias("i", [], { windowsHide: true });
  `;
  assert.deepEqual(
    findWindowsHideViolations(source).map((violation) => violation.call),
    ["run", "execFileAsync", "viaNamespace", "runner", "launch", "assigned", "chained"],
  );
});

test("the Copilot hook script passes the scanner", () => {
  const script = createCopilotCliAmbientContextScript("lavish-axi");
  assert.deepEqual(findWindowsHideViolations(script, "copilot-hook.js"), []);
});

test("server spawn options hide the console window", () => {
  assert.equal(createServerSpawnOptions().windowsHide, true);
  assert.equal(createServerSpawnOptions(17).windowsHide, true);
});

test("the Copilot hook script hides the shell call it runs", () => {
  const script = createCopilotCliAmbientContextScript("lavish-axi");
  assert.match(script, /spawnSync\(command, \[\], \{ encoding: "utf8", shell: true, windowsHide: true \}\)/);
});

test("server connection listing hides the netstat call", () => {
  const seen = [];
  listServerConnections(4601, {
    platform: "win32",
    run: /** @type {any} */ (
      (command, args, options) => {
        seen.push(options);
        return { stdout: "" };
      }
    ),
  });
  assert.equal(seen[0]?.windowsHide, true);
});

test("the win32 browser launch passes the URL as one argument to rundll32", () => {
  assert.deepEqual(windowsBrowserArgs("http://127.0.0.1:4387/session/abc"), [
    "url.dll,FileProtocolHandler",
    "http://127.0.0.1:4387/session/abc",
  ]);
});

// Runtime dependencies that start child processes. Their code is not ours to edit, so each
// unhidden site the scanner finds in them is listed with why lavish-axi leaves it. The test fails
// when a site appears, moves, or goes away, so an upgrade must update this list.
const DEPENDENCY_SPAWN_SITES = [
  {
    site: "open/index.js childProcess.spawn",
    why: "win32 never calls open: openBrowser launches rundll32 with windowsHide instead",
  },
  {
    site: "open/index.js execFile",
    why: "WSL-only default browser lookup; not reached on win32",
  },
  {
    site: "default-browser/windows.js _execFileAsync",
    why: "reg query run by open() on win32. The default parameter is the alias the scanner now follows. lavish-axi no longer calls open() on win32",
  },
  {
    site: "default-browser/index.js execFileAsync",
    why: "macOS and Linux branch (defaults read); not reached on win32",
  },
  {
    site: "cross-spawn/index.js cp.spawn",
    why: "library; forwards the caller's options, and src/plugin.js passes windowsHide: true",
  },
  {
    site: "cross-spawn/index.js cp.spawnSync",
    why: "library; forwards the caller's options, and src/plugin.js passes windowsHide: true",
  },
  {
    site: "axi-sdk-js/dist/update.js execFileAsync",
    why: "LEFT: `lavish-axi update` runs npm view through the SDK; the SDK offers no hook to pass windowsHide",
  },
  {
    site: "axi-sdk-js/dist/update.js spawn",
    why: "LEFT: `lavish-axi update` runs the package manager through the SDK; no windowsHide hook",
  },
];

// Finds the installed directory of a package by the same lookup paths Node uses from the given
// require function. Packages with an exports map cannot be resolved by name, so this searches
// for the directory instead.
function packageDirOf(requireFrom, name) {
  for (const base of requireFrom.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, "package.json"))) return realpathSync(dir);
  }
  throw new Error(`package ${name} not found`);
}

test("runtime dependencies that start child processes match the reviewed list", () => {
  const fromRepo = createRequire(import.meta.url);
  const openDir = packageDirOf(fromRepo, "open");
  const fromOpen = createRequire(path.join(openDir, "index.js"));
  const roots = [
    ["open", openDir],
    ["default-browser", packageDirOf(fromOpen, "default-browser")],
    ["axi-sdk-js", packageDirOf(fromRepo, "axi-sdk-js")],
    ["cross-spawn", packageDirOf(fromRepo, "cross-spawn")],
  ];
  const found = new Set();
  for (const [pkg, dir] of roots) {
    for (const file of listJsFiles(dir)) {
      const source = readFileSync(file, "utf8");
      for (const violation of findWindowsHideViolations(source, file)) {
        found.add(`${pkg}/${path.relative(dir, file).replaceAll("\\", "/")} ${violation.call}`);
      }
    }
  }
  assert.deepEqual([...found].sort(), DEPENDENCY_SPAWN_SITES.map((entry) => entry.site).sort());
});
