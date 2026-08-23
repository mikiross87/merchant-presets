// Lint config for the two kinds of JavaScript in this repo. There is no
// bundler or transpiler, so this is the only static check the code gets
// beyond `node --check`, and it is deliberately narrow: correctness rules
// that catch real mistakes, not a house style.
//
// The split matters because the two halves run in different places.
// `scripts/` is loaded by Foundry in the browser and reads its globals off
// `window`; `tools/` runs under plain Node.

import js from "@eslint/js";
import globals from "globals";

/**
 * Foundry's own globals, as read-only. Not exhaustive — just what this module
 * touches. Add a name here when the runtime starts using it, rather than
 * reaching for an eslint-disable comment.
 */
const foundryGlobals = {
  Actor: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  ChatMessage: "readonly",
  Folder: "readonly",
  Hooks: "readonly",
  Item: "readonly",
  Roll: "readonly",
  RollTable: "readonly",
  foundry: "readonly",
  fromUuid: "readonly",
  game: "readonly",
  ui: "readonly"
};

export default [
  {
    // Generated packs and the JSON content trees hold no linted source.
    ignores: ["packs/**", "_source/**", "data/**"]
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    rules: {
      // An unused `catch (err)` binding or a placeholder argument is fine when
      // it is named for the reader; anything else is a leftover.
      "no-unused-vars": ["error", {
        args: "after-used",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-coercion": ["error", { boolean: false }]
    }
  },

  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.browser, ...foundryGlobals }
    }
  },

  {
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: globals.nodeBuiltin
    }
  }
];
