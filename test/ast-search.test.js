// Tests for src/ast-search.js — symbol extraction, language detection, search, outline
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols, formatSearchResults } from "../src/ast-search.js";

describe("extractSymbols: JavaScript", () => {
  it("extracts function declarations", () => {
    const code = `function hello() { return 1; }
export async function fetchData() {}`;
    const syms = extractSymbols(code, "test.js");
    const fns = syms.filter(s => s.kind === "function");
    assert.ok(fns.some(s => s.name === "hello"));
    assert.ok(fns.some(s => s.name === "fetchData"));
  });

  it("extracts arrow functions assigned to const", () => {
    const code = `const add = (a, b) => a + b;
export const multiply = async (a, b) => a * b;`;
    const syms = extractSymbols(code, "test.js");
    const fns = syms.filter(s => s.kind === "function");
    assert.ok(fns.some(s => s.name === "add"));
    assert.ok(fns.some(s => s.name === "multiply"));
  });

  it("extracts class declarations", () => {
    const code = `class Animal {}
export class Dog extends Animal {}`;
    const syms = extractSymbols(code, "test.js");
    const classes = syms.filter(s => s.kind === "class");
    assert.ok(classes.some(s => s.name === "Animal"));
    assert.ok(classes.some(s => s.name === "Dog"));
  });

  it("extracts import paths", () => {
    const code = `import { readFile } from "node:fs/promises";
import path from "node:path";`;
    const syms = extractSymbols(code, "test.js");
    const imports = syms.filter(s => s.kind === "import");
    assert.ok(imports.some(s => s.name === "node:fs/promises"));
    assert.ok(imports.some(s => s.name === "node:path"));
  });

  it("extracts export names", () => {
    const code = `export function doStuff() {}
export const VALUE = 42;`;
    const syms = extractSymbols(code, "test.js");
    const exports = syms.filter(s => s.kind === "export");
    assert.ok(exports.some(s => s.name === "doStuff"));
    assert.ok(exports.some(s => s.name === "VALUE"));
  });

  it("includes correct line numbers", () => {
    const code = `// line 1
// line 2
function third() {}`;
    const syms = extractSymbols(code, "test.js");
    const fn = syms.find(s => s.name === "third");
    assert.ok(fn);
    assert.equal(fn.line, 3);
  });

  it("returns sorted by line number", () => {
    const code = `const z = () => {};
function a() {}
class M {}`;
    const syms = extractSymbols(code, "test.js");
    for (let i = 1; i < syms.length; i++) {
      assert.ok(syms[i].line >= syms[i - 1].line, "should be sorted by line");
    }
  });
});

describe("extractSymbols: TypeScript", () => {
  it("extracts interfaces", () => {
    const code = `export interface User {
  name: string;
  age: number;
}`;
    const syms = extractSymbols(code, "test.ts");
    const ifaces = syms.filter(s => s.kind === "interface");
    assert.ok(ifaces.some(s => s.name === "User"));
  });

  it("extracts type aliases", () => {
    const code = `export type ID = string | number;
type Config = { key: string };`;
    const syms = extractSymbols(code, "test.ts");
    const types = syms.filter(s => s.kind === "type");
    assert.ok(types.some(s => s.name === "ID"));
    assert.ok(types.some(s => s.name === "Config"));
  });

  it("extracts enums", () => {
    const code = `export enum Color { Red, Green, Blue }
const enum Direction { Up, Down }`;
    const syms = extractSymbols(code, "test.ts");
    const enums = syms.filter(s => s.kind === "enum");
    assert.ok(enums.some(s => s.name === "Color"));
    assert.ok(enums.some(s => s.name === "Direction"));
  });

  it("extracts decorators", () => {
    const code = `@Component
class MyComponent {}`;
    const syms = extractSymbols(code, "test.ts");
    const decorators = syms.filter(s => s.kind === "decorator");
    assert.ok(decorators.some(s => s.name === "Component"));
  });
});

describe("extractSymbols: Python", () => {
  it("extracts function and class definitions", () => {
    const code = `def greet(name):
    return f"Hello {name}"

class Person:
    def __init__(self, name):
        self.name = name

async def fetch_data():
    pass`;
    const syms = extractSymbols(code, "test.py");
    const fns = syms.filter(s => s.kind === "function");
    assert.ok(fns.some(s => s.name === "greet"));
    assert.ok(fns.some(s => s.name === "fetch_data"));
    const classes = syms.filter(s => s.kind === "class");
    assert.ok(classes.some(s => s.name === "Person"));
    const methods = syms.filter(s => s.kind === "method");
    assert.ok(methods.some(s => s.name === "__init__"));
  });

  it("extracts decorators", () => {
    const code = `@staticmethod
def helper():
    pass`;
    const syms = extractSymbols(code, "test.py");
    const decs = syms.filter(s => s.kind === "decorator");
    assert.ok(decs.some(s => s.name === "staticmethod"));
  });
});

describe("extractSymbols: Go", () => {
  it("extracts functions and types", () => {
    const code = `func main() {
}

func (s *Server) Start() error {
    return nil
}

type Server struct {
    port int
}

type Handler interface {
    Handle()
}`;
    const syms = extractSymbols(code, "test.go");
    const fns = syms.filter(s => s.kind === "function");
    assert.ok(fns.some(s => s.name === "main"));
    const methods = syms.filter(s => s.kind === "method");
    assert.ok(methods.some(s => s.name === "Start"));
    const types = syms.filter(s => s.kind === "type");
    assert.ok(types.some(s => s.name === "Server"));
    assert.ok(types.some(s => s.name === "Handler"));
  });
});

describe("extractSymbols: Rust", () => {
  it("extracts functions, structs, enums, traits", () => {
    const code = `pub fn process() -> Result<()> {
    Ok(())
}

pub struct Config {
    name: String,
}

enum Status {
    Active,
    Inactive,
}

pub trait Serialize {
    fn serialize(&self) -> Vec<u8>;
}

macro_rules! debug_print {
    ($e:expr) => { println!("{:?}", $e) }
}`;
    const syms = extractSymbols(code, "test.rs");
    assert.ok(syms.some(s => s.kind === "function" && s.name === "process"));
    assert.ok(syms.some(s => s.kind === "struct" && s.name === "Config"));
    assert.ok(syms.some(s => s.kind === "enum" && s.name === "Status"));
    assert.ok(syms.some(s => s.kind === "trait" && s.name === "Serialize"));
    assert.ok(syms.some(s => s.kind === "macro" && s.name === "debug_print"));
  });
});

describe("extractSymbols: unsupported file types", () => {
  it("returns empty array for unknown extensions", () => {
    assert.deepEqual(extractSymbols("some content", "test.xyz"), []);
    assert.deepEqual(extractSymbols("some content", "test.txt"), []);
    assert.deepEqual(extractSymbols("some content", "Makefile"), []);
  });
});

describe("formatSearchResults", () => {
  it("formats results with symbol info", () => {
    const results = [
      { kind: "function", name: "doStuff", file: "src/main.js", line: 42 },
      { kind: "class", name: "Widget", file: "src/widget.js", line: 10 },
    ];
    const output = formatSearchResults(results);
    assert.ok(output.includes("2 symbol(s)"));
    assert.ok(output.includes("doStuff"));
    assert.ok(output.includes("Widget"));
    assert.ok(output.includes("src/main.js:42"));
  });

  it("returns 'No matching symbols' for empty results", () => {
    assert.ok(formatSearchResults([]).includes("No matching"));
    assert.ok(formatSearchResults(null).includes("No matching"));
  });
});
