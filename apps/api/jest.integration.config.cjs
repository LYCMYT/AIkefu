module.exports = {
  displayName: 'api-integration',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.integration-spec.ts'],
  moduleNameMapper: {
    '^@ai-customer-service/contracts$': '<rootDir>/../../packages/contracts/src',
    '^@ai-customer-service/core$': '<rootDir>/../../packages/core/src'
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts']
};
