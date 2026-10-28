import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated reports, never source.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    // A leading underscore is how this codebase says "deliberately unused" -- the
    // parameter a mock signature must accept, or a field split off with a rest spread.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Standalone Node scripts, run directly with `node`, never bundled. They are
    // CommonJS on purpose -- `require()` is correct here, not debt.
    files: ["generate-proposal.js", "supabase/*.js", "scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
