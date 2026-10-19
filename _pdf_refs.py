import PyPDF2, re, io

p = r'C:\Users\Samer\Downloads\AIOS_Master_Roadmap_Zero_Cost (1).pdf'
r = PyPDF2.PdfReader(p)
text = '\n'.join((pg.extract_text() or '') for pg in r.pages)

for key in ['F-1', 'F-2', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'COST-1',
            'D-003', 'SEC-9', '6.2', '6.4', 'Appendix A']:
    hits = [m.start() for m in re.finditer(re.escape(key), text)]
    print('%-10s occurrences=%d' % (key, len(hits)))

print()
print('--- context around F-1 / B1 ---')
for m in re.finditer(r'F-1|B1\b', text):
    s = max(0, m.start() - 200)
    print('...', text[s:m.start() + 260].replace('\n', ' '))
    print()

out = io.open(r'C:\Users\Samer\Projects\AIOS\_pdf_text.txt', 'w', encoding='utf-8')
out.write(text)
out.close()
print('full text saved for reference')