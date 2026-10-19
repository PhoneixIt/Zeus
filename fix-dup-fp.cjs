const fs = require('fs');
const fullPath = 'C:\\Users\\Samer\\Projects\\AIOS\\packages\\agent\\orchestrator.ts';
let content = fs.readFileSync(fullPath, 'utf8');

// Count occurrences of the fp pattern
const pattern = /const fp = review \? normalizedFindings\(review\.text\) : ''/g;
const matches = content.match(pattern);
console.log('Found', matches ? matches.length : 0, 'occurrences of fp declaration');

// Replace ALL occurrences after the first with reviewFp
// We'll keep the first as is and rename subsequent ones
let count = 0;
content = content.replace(pattern, () => {
    count++;
    if (count === 1) {
        // First occurrence - keep but rename to reviewFp
        return 'const reviewFp = review ? normalizedFindings(review.text) : ';
    }
    // Subsequent occurrences - remove them (they were duplicates)
    return '';
});

if (count >= 2) {
    fs.writeFileSync(fullPath, content);
    console.log('Fixed: renamed second+ fp declarations to reviewFp');
} else if (count === 1) {
    console.log('Only 1 fp declaration - no fix needed');
} else {
    console.log('No fp declarations found');
}

// Verify the fix
const newContent = fs.readFileSync(fullPath, 'utf8');
const newMatches = newContent.match(pattern);
console.log('Remaining fp declarations:', newMatches ? newMatches.length : 0);

// Show surrounding context of the fix
const lines = newContent.split('\n');
for (let i = 420; i <= 510; i++) {
    if (lines[i-1]) {
        console.log(`Line ${i}: ${lines[i-1].substring(0, 100)}`);
    }
}