// ESLint flat config: recommended JS + TypeScript correctness rules plus the
// React hooks rules. Deliberately lean — no stylistic/formatting rules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["dist/", "dev-dist/", "node_modules/", "*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Pragmatic severity tuning for pre-existing patterns in the codebase —
    // surfaced as warnings so `npm run lint` stays a hard gate for new
    // correctness errors without demanding a big-bang cleanup.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
