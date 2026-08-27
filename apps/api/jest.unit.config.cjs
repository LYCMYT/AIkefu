module.exports = {
  displayName: 'api-unit',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['\\.integration-spec\\.ts$'],
  moduleNameMapper: {
    '^@ai-customer-service/contracts$': '<rootDir>/../../packages/contracts/src',
    '^@ai-customer-service/core$': '<rootDir>/../../packages/core/src'
  }
};
