import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        // "_" marks a value left out on purpose (e.g. `const { secret: _drop, ...rest } = item`).
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
