/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      // Point at the test-specific tsconfig that has isolatedModules: true.
      // isolatedModules skips full project-wide type-checking in ts-jest,
      // which dramatically reduces memory usage.
      tsconfig: '<rootDir>/tsconfig.test.json',
      // Disable ts-jest diagnostics (type errors) — type checking is handled
      // by tsc separately. This prevents the full type-program being built.
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@middleware/(.*)$': '<rootDir>/src/middleware/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@t/(.*)$': '<rootDir>/src/types/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
};
