/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Stub out ESM-only packages that cannot be processed by Jest's CommonJS transform
  moduleNameMapper: {
    '^@dank074/discord-video-stream$': '<rootDir>/src/__tests__/__mocks__/@dank074/discord-video-stream.js',
  },
};
