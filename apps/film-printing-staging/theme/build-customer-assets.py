"""Emit immutable theme module names, including each dependency's final name.

Shopify's cached bare asset URLs did not update when only a custom query key
changed. Use the returned entry filename with Liquid's asset_url filter.
"""
import hashlib
import json
import pathlib
import re
import sys

source = pathlib.Path(__file__).resolve().parent
output = pathlib.Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
modules = {}
visiting = set()
imports = re.compile(r"(['\"])\./([a-z0-9-]+\.js)\1")


def build(name):
    if name in modules:
        return modules[name]['file']
    if name in visiting:
        raise ValueError('Cyclic theme module dependency')
    visiting.add(name)
    text = (source / name).read_text()
    text = imports.sub(lambda match: match[1] + './' + build(match[2]) + match[1], text)
    data = text.encode()
    digest = hashlib.sha256(data).hexdigest()
    filename = 'bfl-customer-' + name[:-3] + '-' + digest[:16] + '.js'
    (output / filename).write_bytes(data)
    modules[name] = {'file': filename, 'sha256': digest}
    visiting.remove(name)
    return filename


entry_name = sys.argv[2] if len(sys.argv) > 2 else 'customer-form.js'
if entry_name not in {'customer-form.js', 'persistent-cart.js'}:
    raise ValueError('Unsupported customer entry')
entry = build(entry_name)
print(json.dumps({'entry': entry, 'modules': modules}, indent=2))
