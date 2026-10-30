"""Replace only the historical BFL bootstrap, preserving all other layout bytes.

Usage: python3 build-persistent-layout.py BASELINE ENTRY_ASSET OUTPUT
ENTRY_ASSET is the persistent-cart entry returned by build-customer-assets.py.
No network requests or shared-theme changes are performed by this generator.
"""
import hashlib
import json
from pathlib import Path
import re
import sys

START = b"    {% if shop.permanent_domain == 'bellows-film-printing-staging.myshopify.com' and product.id == 15620086005871 %}\n"


def render(source, entry):
    if not re.fullmatch(r'bfl-customer-persistent-cart-[a-f0-9]{16}\.js', entry):
        raise ValueError('Expected the immutable persistent-cart entry asset')
    if source.count(START) != 1:
        raise ValueError('Historical BFL bootstrap start changed')
    start = source.index(START)
    end_match = re.search(rb'\n[ \t\r\n]*</body>\s*</html>\s*$', source)
    if end_match is None or end_match.start() <= start:
        raise ValueError('Layout ending changed')
    end = end_match.start()
    historical = source[start:end]
    for required in (b'f02-checkout-probe.js', b'bfl-storefront-session.js', b'bfl-cart-preflight-',
                     b'const until=', b'expectedCartHash:', b'bfl-customer-status'):
        if required not in historical:
            raise ValueError('Historical bootstrap is not the expected finite layout')
    template = Path(__file__).with_name('persistent-bootstrap.liquid').read_bytes()
    if template.count(b'__BFL_PERSISTENT_ENTRY__') != 1:
        raise ValueError('Persistent bootstrap entry must appear once')
    return source[:start] + template.rstrip(b'\n').replace(b'__BFL_PERSISTENT_ENTRY__', entry.encode()) + source[end:]


if __name__ == '__main__':
    baseline, entry, destination = sys.argv[1:]
    source = Path(baseline).read_bytes()
    result = render(source, entry)
    target = Path(destination)
    if target.resolve() == Path(baseline).resolve():
        raise ValueError('Write a separate prospective layout; never overwrite the live baseline')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result)
    print(json.dumps({'file': str(target), 'sha256': hashlib.sha256(result).hexdigest(),
                      'baseline_sha256': hashlib.sha256(source).hexdigest(), 'entry': entry}))
