module.exports = {
  preset: '@react-native/jest-preset',
  roots: ['<rootDir>/__tests__'],
  modulePathIgnorePatterns: ['<rootDir>/archive/'],
  watchPathIgnorePatterns: ['<rootDir>/archive/'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-safe-area-context|react-native-webview)/)',
  ],
};
