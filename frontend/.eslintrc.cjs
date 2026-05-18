/**
 * ESLint config for the Vite + React 18 SPA. Intentionally minimal: enable
 * the rules that catch the audit findings (unused vars, undeclared vars,
 * missing hook deps, accidental `var`) without forcing a stylistic rewrite
 * of the existing code (no Prettier, no jsx-a11y, no import-order).
 *
 * Run with: `npm run lint --workspace=frontend`
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs', 'vite.config.js'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  rules: {
    // The cleanups in audit Tier 1/2 already removed unused imports; keep
    // this rule on so they don't creep back in. `_`-prefixed vars are an
    // explicit "intentionally unused" escape hatch.
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'react/prop-types': 'off',          // Project doesn't use prop-types.
    'react/no-unknown-property': 'warn',
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    'react-hooks/exhaustive-deps': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-irregular-whitespace': 'warn',
  },
}
