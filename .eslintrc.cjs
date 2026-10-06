/**
 * This is intended to be a basic starting point for linting in your app.
 * It relies on recommended configs out of the box for simplicity, but you can
 * and should modify this configuration to best suit your team's needs.
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  env: {
    browser: true,
    commonjs: true,
    es2022: true,
  },
  ignorePatterns: ["!**/.server", "!**/.client"],

  // Base config
  extends: ["eslint:recommended"],

  overrides: [
    // React
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      plugins: ["react", "jsx-a11y"],
      extends: [
        "plugin:react/recommended",
        "plugin:react/jsx-runtime",
        "plugin:react-hooks/recommended",
        "plugin:jsx-a11y/recommended",
      ],
      settings: {
        react: {
          version: "detect",
        },
        formComponents: ["Form"],
        linkComponents: [
          { name: "Link", linkAttribute: "to" },
          { name: "NavLink", linkAttribute: "to" },
        ],
        "import/resolver": {
          typescript: {},
        },
      },
      rules: {
        "react/no-unknown-property": ["error", { ignore: ["variant"] }],
        // Wording in page text is fine; what matters is code that refers to things that do not exist (no-undef).
        "react/no-unescaped-entities": "off",
        // This project does not use PropTypes (components are small and checked by the build and tests).
        "react/prop-types": "off",
        // The text of a label often sits a few elements deep (label > span > strong > {t("...")}).
        "jsx-a11y/label-has-associated-control": ["error", { depth: 4 }],
        "no-empty": ["error", { allowEmptyCatch: true }],
        // Unused variables are worth a look, but they are not errors that should stop a release.
        "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_", caughtErrors: "none" }],
      },
    },

    // Typescript
    {
      files: ["**/*.{ts,tsx}"],
      plugins: ["@typescript-eslint", "import"],
      parser: "@typescript-eslint/parser",
      settings: {
        "import/internal-regex": "^~/",
        "import/resolver": {
          node: {
            extensions: [".ts", ".tsx"],
          },
          typescript: {
            alwaysTryTypes: true,
          },
        },
      },
      extends: [
        "plugin:@typescript-eslint/recommended",
        "plugin:import/recommended",
        "plugin:import/typescript",
      ],
    },

    // Node
    {
      files: [
        ".eslintrc.cjs",
        "vite.config.{js,ts}",
        ".graphqlrc.{js,ts}",
        "shopify.server.{js,ts}",
        "**/*.server.{js,ts}",
      ],
      env: {
        node: true,
      },
    },

    // Server code is not React: names that start with "use" there (useCurrency...) are ordinary functions.
    {
      files: ["**/*.server.{js,ts}"],
      rules: { "react-hooks/rules-of-hooks": "off" },
    },

    // The script that runs on shoppers' pages creates a few helpers at runtime (window.__hfT and friends).
    {
      files: ["extensions/**/*.js"],
      env: { browser: true },
      globals: { __hfT: "readonly", __hfApprox: "readonly", __hfCurrencyNote: "readonly", Shopify: "readonly" },
      rules: { "no-extra-semi": "off", "no-cond-assign": "off" },
    },

    // Scripts that run on a computer, not in a browser.
    {
      files: ["**/*.cjs", "tests/**", "loadtest/**"],
      env: { node: true },
    },
  ],
  globals: {
    shopify: "readonly",
    process: "readonly",
    Buffer: "readonly",
  },
};
