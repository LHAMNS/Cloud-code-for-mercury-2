/**
 * Tests for ast-search.js — regex-based symbol extraction.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { searchSymbols, fileOutline } from "../src/ast-search.js";

let tmpDir;
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ast-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("AST search: JavaScript symbol extraction", () => {
  it("finds functions and classes in JS via workspace search", async () => {
    const file = path.join(tmpDir, "example.js");
    await writeFile(file, `
function greet(name) { return "Hello " + name; }
class UserService {
  constructor(db) { this.db = db; }
  async getUser(id) { return this.db.find(id); }
}
const helper = () => {};
export default function main() {}
    `.trim(), "utf-8");
    // searchSymbols takes (workspace, query) — searches directory
    const symbols = await searchSymbols(tmpDir, "greet");
    assert.ok(symbols.length > 0, "Should find 'greet' function");
    const outline = await fileOutline(file);
    assert.ok(typeof outline === "string", "fileOutline should return a string");
    assert.ok(outline.includes("greet"), `Outline should include 'greet': ${outline.slice(0, 200)}`);
    assert.ok(outline.includes("UserService"), `Outline should include 'UserService': ${outline.slice(0, 200)}`);
  });

  it("finds symbols in TypeScript", async () => {
    const file = path.join(tmpDir, "example.ts");
    await writeFile(file, `
interface Config { port: number; host: string; }
type Handler = (req: Request) => Response;
class Server {
  private config: Config;
  constructor(config: Config) { this.config = config; }
  start(): void {}
}
function createServer(config: Config): Server { return new Server(config); }
    `.trim(), "utf-8");
    const symbols = await searchSymbols(tmpDir, "Server");
    assert.ok(symbols.length > 0, "Should find 'Server' class");
    const outline = await fileOutline(file);
    assert.ok(outline.includes("Server"), "Should find class Server in outline");
  });

  it("finds symbols in Python", async () => {
    const file = path.join(tmpDir, "example.py");
    await writeFile(file, `
class DataProcessor:
    def __init__(self, data):
        self.data = data
    def process(self):
        return [x * 2 for x in self.data]

def main():
    dp = DataProcessor([1, 2, 3])
    print(dp.process())
    `.trim(), "utf-8");
    const symbols = await searchSymbols(tmpDir, "DataProcessor");
    assert.ok(symbols.length > 0, "Should find DataProcessor class");
  });

  it("returns empty for non-existent directory", async () => {
    const symbols = await searchSymbols("/tmp/nonexistent-dir-xyz-12345", "test");
    assert.ok(Array.isArray(symbols), "Should return array");
    assert.equal(symbols.length, 0, "Should be empty for non-existent dir");
  });

  it("handles Go file symbols", async () => {
    const file = path.join(tmpDir, "example.go");
    await writeFile(file, `
package main

type Server struct {
    Port int
}

func (s *Server) Start() error {
    return nil
}

func NewServer(port int) *Server {
    return &Server{Port: port}
}
    `.trim(), "utf-8");
    const symbols = await searchSymbols(tmpDir, "Server");
    assert.ok(symbols.length > 0, "Should find Go symbols");
  });

  it("handles Rust file symbols", async () => {
    const file = path.join(tmpDir, "example.rs");
    await writeFile(file, `
struct Config {
    port: u16,
    host: String,
}

impl Config {
    fn new(port: u16) -> Self {
        Config { port, host: String::from("localhost") }
    }
}

fn main() {
    let cfg = Config::new(8080);
}
    `.trim(), "utf-8");
    const symbols = await searchSymbols(tmpDir, "Config");
    assert.ok(symbols.length > 0, "Should find Rust symbols");
  });
});
