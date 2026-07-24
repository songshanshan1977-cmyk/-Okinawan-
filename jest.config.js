const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js", "**/tests/db-integration/**/*.test.js"],
  clearMocks: true,
  // Guardrail: any accidental real network call from a test fails loudly
  // instead of silently hitting Stripe/Supabase. Individual tests still
  // mock 'stripe', '@supabase/supabase-js' and 'resend' explicitly.
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
};

module.exports = createJestConfig(customJestConfig);
