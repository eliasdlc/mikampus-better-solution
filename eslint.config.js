export default [
  {
    files: ['src/**/*.js', 'scripts/**/*.mjs'],
    ignores: ['scripts/audit-public.mjs'],
    rules: {
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'valid-typeof': 'error'
    }
  }
];
