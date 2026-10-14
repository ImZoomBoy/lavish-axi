import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { createCopilotCliAmbientContextScript, createServerSpawnOptions, listServerConnections } from "../src/cli.js";

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
  return bindings;
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
