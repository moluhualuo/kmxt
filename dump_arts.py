import json
d = json.load(open('data/kmxt.json', encoding='utf-8'))
arts = d.get('modelArtifacts', [])
print('total artifacts:', len(arts))
for a in arts:
    print(a.get('name'), '| size=', a.get('size'), '| status=', a.get('status'), '| sha=', (a.get('cipherSha256') or '')[:16], '| id=', a.get('id'))
