//! AST-based code search for Mercury Code.
//! Uses regex patterns to find function/class/method definitions.

use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use once_cell::sync::Lazy;

/// A symbol found in source code.
#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub line: usize,
    pub file: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymbolKind {
    Function, Class, Method, Interface, Struct, Enum, Trait, Const, Variable, Type, Module,
}

impl std::fmt::Display for SymbolKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Function => write!(f, "function"),
            Self::Class => write!(f, "class"),
            Self::Method => write!(f, "method"),
            Self::Interface => write!(f, "interface"),
            Self::Struct => write!(f, "struct"),
            Self::Enum => write!(f, "enum"),
            Self::Trait => write!(f, "trait"),
            Self::Const => write!(f, "const"),
            Self::Variable => write!(f, "variable"),
            Self::Type => write!(f, "type"),
            Self::Module => write!(f, "module"),
        }
    }
}

/// Language-specific regex patterns for symbol detection.
struct LangPatterns {
    patterns: Vec<(SymbolKind, Regex)>,
}

static JS_PATTERNS: Lazy<LangPatterns> = Lazy::new(|| LangPatterns {
    patterns: vec![
        (SymbolKind::Function, Regex::new(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)").unwrap()),
        (SymbolKind::Class, Regex::new(r"(?:export\s+)?class\s+(\w+)").unwrap()),
        (SymbolKind::Const, Regex::new(r"(?:export\s+)?const\s+(\w+)\s*=").unwrap()),
        (SymbolKind::Method, Regex::new(r"^\s+(?:async\s+)?(\w+)\s*\(").unwrap()),
    ],
});

static PYTHON_PATTERNS: Lazy<LangPatterns> = Lazy::new(|| LangPatterns {
    patterns: vec![
        (SymbolKind::Function, Regex::new(r"^(?:async\s+)?def\s+(\w+)").unwrap()),
        (SymbolKind::Class, Regex::new(r"^class\s+(\w+)").unwrap()),
    ],
});

static RUST_PATTERNS: Lazy<LangPatterns> = Lazy::new(|| LangPatterns {
    patterns: vec![
        (SymbolKind::Function, Regex::new(r"(?:pub\s+)?(?:async\s+)?fn\s+(\w+)").unwrap()),
        (SymbolKind::Struct, Regex::new(r"(?:pub\s+)?struct\s+(\w+)").unwrap()),
        (SymbolKind::Enum, Regex::new(r"(?:pub\s+)?enum\s+(\w+)").unwrap()),
        (SymbolKind::Trait, Regex::new(r"(?:pub\s+)?trait\s+(\w+)").unwrap()),
        (SymbolKind::Type, Regex::new(r"(?:pub\s+)?type\s+(\w+)").unwrap()),
        (SymbolKind::Module, Regex::new(r"(?:pub\s+)?mod\s+(\w+)").unwrap()),
        (SymbolKind::Const, Regex::new(r"(?:pub\s+)?const\s+(\w+)").unwrap()),
    ],
});

static GO_PATTERNS: Lazy<LangPatterns> = Lazy::new(|| LangPatterns {
    patterns: vec![
        (SymbolKind::Function, Regex::new(r"^func\s+(\w+)").unwrap()),
        (SymbolKind::Method, Regex::new(r"^func\s+\([^)]+\)\s+(\w+)").unwrap()),
        (SymbolKind::Struct, Regex::new(r"^type\s+(\w+)\s+struct").unwrap()),
        (SymbolKind::Interface, Regex::new(r"^type\s+(\w+)\s+interface").unwrap()),
    ],
});

static JAVA_PATTERNS: Lazy<LangPatterns> = Lazy::new(|| LangPatterns {
    patterns: vec![
        (SymbolKind::Class, Regex::new(r"(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)").unwrap()),
        (SymbolKind::Interface, Regex::new(r"(?:public\s+)?interface\s+(\w+)").unwrap()),
        (SymbolKind::Method, Regex::new(r"(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)(\w+)\s*\(").unwrap()),
    ],
});

/// Get language patterns based on file extension.
fn get_patterns(ext: &str) -> Option<&'static LangPatterns> {
    match ext {
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => Some(&*JS_PATTERNS),
        "py" | "pyw" => Some(&*PYTHON_PATTERNS),
        "rs" => Some(&*RUST_PATTERNS),
        "go" => Some(&*GO_PATTERNS),
        "java" | "kt" | "scala" => Some(&*JAVA_PATTERNS),
        _ => None,
    }
}

/// Search for symbols by name across files.
pub fn search_symbols(root: &Path, query: &str) -> Vec<Symbol> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file());

    for entry in walker {
        let path = entry.path();
        let path_str = path.to_string_lossy();
        if path_str.contains("/.git/") || path_str.contains("/node_modules/") || path_str.contains("/target/") {
            continue;
        }

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let patterns = match get_patterns(ext) {
            Some(p) => p,
            None => continue,
        };

        if let Ok(content) = std::fs::read_to_string(path) {
            for (line_num, line) in content.lines().enumerate() {
                for (kind, regex) in &patterns.patterns {
                    if let Some(cap) = regex.captures(line) {
                        if let Some(name) = cap.get(1) {
                            let name_str = name.as_str();
                            if name_str.to_lowercase().contains(&query_lower) {
                                results.push(Symbol {
                                    name: name_str.to_string(),
                                    kind: kind.clone(),
                                    line: line_num + 1,
                                    file: path.to_string_lossy().to_string(),
                                    source: Some(line.trim().to_string()),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    results
}

/// Extract all symbols from a single file (file outline).
pub fn file_outline(file_path: &Path) -> Vec<Symbol> {
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let patterns = match get_patterns(ext) {
        Some(p) => p,
        None => return Vec::new(),
    };

    let content = match std::fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut symbols = Vec::new();
    for (line_num, line) in content.lines().enumerate() {
        for (kind, regex) in &patterns.patterns {
            if let Some(cap) = regex.captures(line) {
                if let Some(name) = cap.get(1) {
                    symbols.push(Symbol {
                        name: name.as_str().to_string(),
                        kind: kind.clone(),
                        line: line_num + 1,
                        file: file_path.to_string_lossy().to_string(),
                        source: Some(line.trim().to_string()),
                    });
                }
            }
        }
    }

    symbols
}

/// Extract symbols with their full source code (including body).
pub fn extract_symbols(file_path: &Path, symbol_name: &str) -> Vec<Symbol> {
    let outline = file_outline(file_path);
    outline.into_iter().filter(|s| s.name == symbol_name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_js_function_detection() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.js");
        std::fs::write(&file, "export function hello() {\n  return 1;\n}\n\nconst foo = 42;\n").unwrap();
        let symbols = file_outline(&file);
        assert!(symbols.iter().any(|s| s.name == "hello" && s.kind == SymbolKind::Function));
        assert!(symbols.iter().any(|s| s.name == "foo" && s.kind == SymbolKind::Const));
    }

    #[test]
    fn test_rust_detection() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.rs");
        std::fs::write(&file, "pub struct Foo {}\npub fn bar() {}\npub enum Baz {}\n").unwrap();
        let symbols = file_outline(&file);
        assert!(symbols.iter().any(|s| s.name == "Foo" && s.kind == SymbolKind::Struct));
        assert!(symbols.iter().any(|s| s.name == "bar" && s.kind == SymbolKind::Function));
        assert!(symbols.iter().any(|s| s.name == "Baz" && s.kind == SymbolKind::Enum));
    }

    #[test]
    fn test_python_detection() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.py");
        std::fs::write(&file, "def hello():\n    pass\n\nclass MyClass:\n    pass\n").unwrap();
        let symbols = file_outline(&file);
        assert!(symbols.iter().any(|s| s.name == "hello" && s.kind == SymbolKind::Function));
        assert!(symbols.iter().any(|s| s.name == "MyClass" && s.kind == SymbolKind::Class));
    }

    #[test]
    fn test_search_symbols() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.js"), "function fooBar() {}\n").unwrap();
        std::fs::write(dir.path().join("b.js"), "function bazQux() {}\n").unwrap();
        let results = search_symbols(dir.path(), "foo");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "fooBar");
    }

    #[test]
    fn test_extract_symbols() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.rs");
        std::fs::write(&file, "fn foo() {}\nfn bar() {}\nfn foo_helper() {}\n").unwrap();
        let results = extract_symbols(&file, "foo");
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_unknown_extension() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.xyz");
        std::fs::write(&file, "some content").unwrap();
        let symbols = file_outline(&file);
        assert!(symbols.is_empty());
    }
}
