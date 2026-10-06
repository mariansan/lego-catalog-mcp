import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", ".vercel/**", "**/data/**", "**/.cache/**", "dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain .mjs scripts run in Node.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // Type errors are never suppressed.
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
);
