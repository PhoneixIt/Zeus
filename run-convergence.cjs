const { execSync } = require('child_process');
try {
  const result = execSync('node --experimental-strip-types --no-warnings --test "C:\\Users\\Samer\\Projects\\AIOS\\packages\\agent\\test\\convergence.test.ts"', { maxBuffer: 10 * 1024 * 1024 });
  process.exit(0);
} catch (e) {
  process.exit(1);
}