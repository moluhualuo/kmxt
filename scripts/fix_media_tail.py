from pathlib import Path

path = Path('public/styles.css')
text = path.read_text(encoding='utf-8')

orphan = '''
  .announcement-card {
    padding: 12px;
  }

  .announcement-title {
    font-size: 16px;
  }

  .announcement-body {
    font-size: 14px;
  }
'''
text = text.replace(orphan, '')

block = '''  .announcement-card {
    padding: 12px;
  }

  .announcement-title {
    font-size: 16px;
  }

  .announcement-body {
    font-size: 14px;
  }'''

start = text.find('@media (max-width: 820px) {')
if start == -1:
    raise SystemExit('820px media query not found')

next_media = text.find('\n@media (max-width: 600px) {', start)
if next_media == -1:
    raise SystemExit('600px media query not found')

before = text[:next_media]
after = text[next_media:]

if block not in before:
    last_brace = before.rfind('}')
    if last_brace == -1:
        raise SystemExit('closing brace not found in 820px block')
    before = before[:last_brace] + '\n' + block + '\n}\n'
    after = after[1:] if after.startswith('\n') else after

text = before + after
path.write_text(text, encoding='utf-8')
