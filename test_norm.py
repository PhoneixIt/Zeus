import re

def normalizedFindings(text):
    result = text.lower()
    result = re.sub(r'[-_/]+', ' ', result)
    result = re.sub(r'[^a-z\s]', '', result)
    result = re.sub(r'\s+', ' ', result)
    result = result.strip()
    result = result[:600]
    return result

# Test with the reviewer texts from the FRESH BUT UNRESOLVABLE test
texts = [
    'Round 1: raise the bar one more notch. Consider requirement 1.',
    'Round 2: raise the bar one more notch. Consider requirement 2.',
    'Round 3: raise the bar one more notch. Consider requirement 3.',
]

for i, text in enumerate(texts):
    result = normalizedFindings(text)
    print(f'Text {i+1}: {text}')
    print(f'  Normalized: "{result}"')
    print()