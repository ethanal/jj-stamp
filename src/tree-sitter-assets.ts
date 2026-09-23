/// <reference types="vite/client" />

import core from "web-tree-sitter/web-tree-sitter.wasm?url";
import bash from "tree-sitter-wasm/bash/tree-sitter-bash.wasm?url";
import c from "tree-sitter-wasm/c/tree-sitter-c.wasm?url";
import cpp from "tree-sitter-wasm/cpp/tree-sitter-cpp.wasm?url";
import cSharp from "tree-sitter-wasm/c_sharp/tree-sitter-c_sharp.wasm?url";
import go from "tree-sitter-wasm/go/tree-sitter-go.wasm?url";
import java from "tree-sitter-wasm/java/tree-sitter-java.wasm?url";
import javascript from "tree-sitter-wasm/javascript/tree-sitter-javascript.wasm?url";
import php from "tree-sitter-wasm/php/tree-sitter-php.wasm?url";
import python from "tree-sitter-wasm/python/tree-sitter-python.wasm?url";
import ruby from "tree-sitter-wasm/ruby/tree-sitter-ruby.wasm?url";
import rust from "tree-sitter-wasm/rust/tree-sitter-rust.wasm?url";
import tsx from "tree-sitter-wasm/tsx/tree-sitter-tsx.wasm?url";
import typescript from "tree-sitter-wasm/typescript/tree-sitter-typescript.wasm?url";
import type { TreeSitterAssets } from "./hunk-context";

export const treeSitterAssets: TreeSitterAssets = {
  core,
  languages: {
    bash,
    c,
    cpp,
    cSharp,
    go,
    java,
    javascript,
    php,
    python,
    ruby,
    rust,
    tsx,
    typescript,
  },
};
