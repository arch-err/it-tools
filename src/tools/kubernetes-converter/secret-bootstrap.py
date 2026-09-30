#!/usr/bin/env python3
"""Import referenced Kubernetes Secret keys without putting values in argv or logs."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys


def resources(value):
    if isinstance(value, list):
        for item in value:
            yield from resources(item)
    elif isinstance(value, dict) and value.get('kind') == 'List':
        yield from resources(value.get('items', []))
    elif isinstance(value, dict):
        yield value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='Kubernetes Secret JSON/List, or the separately downloaded secrets.json')
    parser.add_argument('--dry-run', action='store_true', help='Validate all keys without changing Podman')
    args = parser.parse_args()
    references = json.loads(Path(__file__).with_name('secret-references.json').read_text())
    source = json.loads(Path(args.input).read_text())
    secrets = {}
    for resource in resources(source):
        if resource.get('kind') != 'Secret':
            continue
        metadata = resource.get('metadata', {})
        identity = (metadata.get('namespace', 'default'), metadata['name'])
        if identity in secrets:
            raise ValueError(f'Duplicate Secret {identity[0]}/{identity[1]}')
        secrets[identity] = resource
    pending = []
    for ref in references:
        identity = (ref['namespace'], ref['name'])
        secret = secrets.get(identity, {})
        key = ref['key']
        if key in secret.get('stringData', {}):
            value = secret['stringData'][key].encode()
        elif key in secret.get('data', {}):
            value = base64.b64decode(secret['data'][key], validate=True)
        else:
            raise ValueError(f'Missing Secret {identity[0]}/{identity[1]} key {key}')
        if not 0 < len(value) < 512000:
            raise ValueError('Podman secret size must be between 1 and 511999 bytes')
        pending.append((ref['podmanName'], value))
    # Validate everything before replacing any existing secrets.
    for name, value in pending:
        if not args.dry_run:
            subprocess.run(['podman', 'secret', 'create', '--replace', name, '-'], input=value,
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f'{"Validated" if args.dry_run else "Imported"} {name}')
    if not args.dry_run:
        print('Recreate the consuming containers after rotating secrets.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError):
        # Never echo parser or runtime errors that might contain secret contents.
        print('Secret import failed. Check JSON, required keys, and Podman access. No values were logged.', file=sys.stderr)
        sys.exit(1)
