import { createDefaultEsmPreset, type JestConfigWithTsJest } from "ts-jest";

const presetConfig = createDefaultEsmPreset({
  tsconfig: "tsconfig.json",
});

const jestConfig: JestConfigWithTsJest = {
  ...presetConfig,
  testMatch: ["**/src/test/*.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/src/test/jest.setup.ts"],
};

export default jestConfig;
