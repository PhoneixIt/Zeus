#!/usr/bin/env python3
import re
import json

def normalizedFindings(text):
    result = text.lower()
    result = re.sub(r'[-_/]+', ' ', result)
    result = re.sub(r'[^a-z0-9\s]', '', result)
    result = re.sub(r'\s+', ' ', result)
    result = result.strip()
    result = result[:600]
    return result

texts = [
    'Round 1: raise the bar one more notch. Consider requirement 1.',
    'Round 2: raise the bar one more notch. Consider requirement 2.',
    'Round 3: raise the bar one more notch. Consider requirement 3.',
]

print('Normalized findings with current regex (preserves digits):')
results = []
for i, text in enumerate(texts):
    result = normalizedFindings(text)
    results.append(result)
    print(f'Round {i+1}: "{result}"')

print()
print('All different:', len(set(results)) == 3)
print('Results set:', set(results))

# Also test: what if the regex did NOT preserve digits (old behavior)
def old_normalizedFindings(text):
    result = text.lower()
    result = re.sub(r'[-_/]+', ' ', result)
    result = re.sub(r'[^a-z\s]', '', result)  # Old: no digit preservation
    result = re.sub(r'\s+', ' ', result)
    result = result.strip()
    result = result[:600]
    return result

old_results = []
for i, text in enumerate(texts):
    result = old_normalizedFindings(text)
    old_results.append(result)
    print(f'Old round {i+1}: "{result}"')

print()
print('Old: All different:', len(set(old_results)) == 3)
print('Old results set:', set(old_results))