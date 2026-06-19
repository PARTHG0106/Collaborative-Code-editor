/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ['@collab/eslint-config'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
};
