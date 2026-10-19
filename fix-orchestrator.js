const fs = require('fs');
const path = require('path');
const orchPath = path.join('C:\\Users\\Samer\\Projects\\AIOS', 'packages', 'agent', 'orchestrator.ts');

let content = fs.readFileSync(orchPath, 'utf8');

// Find and fix the duplicate fp declaration
// Line 426 has: const fp = review ? normalizedFindings(review.text) : ''
// Line ~503 has: const fp = review ? normalizedFindings(review.text) : ''

// We need to rename the second occurrence to reviewFp
// Let's find both occurrences and their contexts

const lines = content.split('\n');
let fixed = false;

// First, find all lines with 'const fp' 
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('const fp = review ? normalizedFindings(review.text) :')) {
        console.log(`Found fp at line ${i+1}: ${lines[i].substring(0, 80)}`);
    }
}

// Now fix: replace the second occurrence
// Strategy: find line 503 area and rename
let count = 0;
content = content.replace(
    /const fp = review \? normalizedFindings\(review\.text\) : ''/g,
    () => {
        count++;
        if (count === 1) {
            // Keep first as fp (or change to reviewFp depending on context)
            return 'const reviewFp = review ? normalizedFindings(review.text) : ';
        }
        return ''; // remove second occurrence
    }
);

if (count >= 2) {
    fs.writeFileSync(orchPath, content);
    console.log('Fixed duplicate fp declarations');
} else {
    console.log(`Only found ${count} fp declarations`);
}