import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractSymbols, searchSymbols, fileOutline, formatSearchResults } from "../src/ast-search.js";

describe("extractSymbols - JavaScript", () => {
  it("extracts named functions", () => { assert.ok(extractSymbols('function hello() {}', "t.js").some(s => s.kind === "function" && s.name === "hello")); });
  it("extracts async functions", () => { assert.ok(extractSymbols("async function fetchData() {}", "t.js").some(s => s.name === "fetchData")); });
  it("extracts arrow functions", () => { assert.ok(extractSymbols("const add = (a, b) => a + b;", "t.js").some(s => s.name === "add")); });
  it("extracts exported functions", () => { assert.ok(extractSymbols("export function greet() {}", "t.js").some(s => s.name === "greet")); });
  it("extracts classes", () => { assert.ok(extractSymbols("class MyService {}", "t.js").some(s => s.kind === "class" && s.name === "MyService")); });
  it("extracts class methods", () => { assert.ok(extractSymbols("class F {\n  bar() {\n  }\n}", "t.js").some(s => s.kind === "method" && s.name === "bar")); });
  it("extracts imports", () => { assert.ok(extractSymbols('import { readFile } from "node:fs/promises";', "t.js").some(s => s.kind === "import")); });
  it("extracts exports", () => { assert.ok(extractSymbols("export const MAX = 100;", "t.js").some(s => s.name === "MAX")); });
  it("extracts variables", () => { assert.ok(extractSymbols('const API = "url";', "t.js").some(s => s.name === "API")); });
  it("returns empty for unsupported type", () => { assert.deepEqual(extractSymbols("content", "t.txt"), []); });
  it("sorts by line number", () => { const syms = extractSymbols("function b() {}\nfunction a() {}", "t.js").filter(s => s.kind === "function"); assert.ok(syms.length >= 2 && syms[0].line <= syms[1].line); });
});

describe("extractSymbols - TypeScript", () => {
  it("extracts interfaces", () => { assert.ok(extractSymbols("export interface User { name: string; }", "t.ts").some(s => s.kind === "interface" && s.name === "User")); });
  it("extracts type aliases", () => { assert.ok(extractSymbols("type ID = string;", "t.ts").some(s => s.kind === "type" && s.name === "ID")); });
  it("extracts enums", () => { assert.ok(extractSymbols("export enum Color { Red }", "t.ts").some(s => s.kind === "enum" && s.name === "Color")); });
  it("extracts abstract classes", () => { assert.ok(extractSymbols("abstract class Base {}", "t.ts").some(s => s.kind === "class" && s.name === "Base")); });
  it("extracts decorators", () => { assert.ok(extractSymbols("@Component\nclass C {}", "t.ts").some(s => s.kind === "decorator" && s.name === "Component")); });
});

describe("extractSymbols - Python", () => {
  it("extracts functions", () => { assert.ok(extractSymbols("def hello():\n    pass", "t.py").some(s => s.kind === "function" && s.name === "hello")); });
  it("extracts async functions", () => { assert.ok(extractSymbols("async def fetch():\n    pass", "t.py").some(s => s.name === "fetch")); });
  it("extracts classes", () => { assert.ok(extractSymbols("class MyClass:\n    pass", "t.py").some(s => s.kind === "class" && s.name === "MyClass")); });
  it("extracts methods", () => { assert.ok(extractSymbols("class F:\n    def bar(self):\n        pass", "t.py").some(s => s.kind === "method" && s.name === "bar")); });
  it("extracts decorators", () => { assert.ok(extractSymbols("@staticmethod\ndef foo():\n    pass", "t.py").some(s => s.kind === "decorator")); });
});

describe("extractSymbols - Go", () => {
  it("extracts functions", () => { assert.ok(extractSymbols("func main() {\n}", "m.go").some(s => s.name === "main")); });
  it("extracts methods", () => { assert.ok(extractSymbols("func (s *S) Start() error {\n}", "s.go").some(s => s.name === "Start")); });
  it("extracts types", () => { assert.ok(extractSymbols("type Config struct {\n}", "c.go").some(s => s.name === "Config")); });
});

describe("extractSymbols - Rust", () => {
  it("extracts functions", () => { assert.ok(extractSymbols("fn main() {\n}", "m.rs").some(s => s.name === "main")); });
  it("extracts pub functions", () => { assert.ok(extractSymbols("pub fn process() {}", "l.rs").some(s => s.name === "process")); });
  it("extracts structs", () => { assert.ok(extractSymbols("pub struct Config { port: u16 }", "l.rs").some(s => s.kind === "struct" && s.name === "Config")); });
  it("extracts enums", () => { assert.ok(extractSymbols("enum Color { Red }", "l.rs").some(s => s.kind === "enum" && s.name === "Color")); });
  it("extracts traits", () => { assert.ok(extractSymbols("pub trait Drawable { fn draw(&self); }", "l.rs").some(s => s.kind === "trait" && s.name === "Drawable")); });
});

describe("searchSymbols", () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-ast-"));
    await writeFile(path.join(tmpDir, "app.js"), "function greetUser() {}\nclass UserService {}");
    await writeFile(path.join(tmpDir, "u.py"), "def helper():\n    pass\nclass DataProc:\n    pass");
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("searches by name", async () => { assert.ok((await searchSymbols(tmpDir, "greet")).some(s => s.name === "greetUser")); });
  it("searches across languages", async () => { assert.ok((await searchSymbols(tmpDir, ".*")).length > 3); });
  it("filters by kind", async () => { const r = await searchSymbols(tmpDir, ".*", { kind: "class" }); assert.ok(r.every(s => s.kind === "class")); });
  it("filters by language", async () => { assert.ok((await searchSymbols(tmpDir, ".*", { language: "python" })).every(s => s.file.endsWith(".py"))); });
  it("respects maxResults", async () => { assert.ok((await searchSymbols(tmpDir, ".*", { maxResults: 2 })).length <= 2); });
  it("handles invalid regex", async () => { assert.ok(Array.isArray(await searchSymbols(tmpDir, "[invalid(regex"))); });
  it("skips node_modules", async () => {
    await mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(tmpDir, "node_modules", "pkg", "i.js"), "function shouldSkip() {}");
    assert.equal((await searchSymbols(tmpDir, "shouldSkip")).length, 0);
  });
});

describe("fileOutline", () => {
  let tmpDir;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "mercury-ol-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
  it("returns structured outline", async () => {
    const f = path.join(tmpDir, "t.js");
    await writeFile(f, "function foo() {}\nclass Bar {}");
    assert.ok((await fileOutline(f)).includes("foo") && (await fileOutline(f)).includes("Bar"));
  });
  it("returns error for nonexistent", async () => { assert.ok((await fileOutline(path.join(tmpDir, "x.js"))).includes("Error")); });
  it("returns unsupported for unknown ext", async () => { const f = path.join(tmpDir, "d.csv"); await writeFile(f, "a,b"); assert.ok((await fileOutline(f)).includes("Unsupported")); });
});

describe("formatSearchResults", () => {
  it("no-match for empty", () => { assert.ok(formatSearchResults([]).includes("No matching")); });
  it("no-match for null", () => { assert.ok(formatSearchResults(null).includes("No matching")); });
  it("formats results", () => { assert.ok(formatSearchResults([{ kind: "function", name: "hello", file: "src/app.js", line: 10 }]).includes("hello")); });
});
