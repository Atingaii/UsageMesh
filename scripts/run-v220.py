from pathlib import Path

path = Path('scripts/apply-v220.py')
source = path.read_text()
# crypto.rs has a semicolon after bail!, while main.rs intentionally does not.
# Patch only the first occurrence in the migration source (the crypto anchor).
source = source.replace(
    '        bail!(\\"dashboard password must be at least 8 bytes long\\")\\n    }',
    '        bail!(\\"dashboard password must be at least 8 bytes long\\");\\n    }',
    1,
)
namespace = {'__name__': '__main__', '__file__': str(path)}
exec(compile(source, str(path), 'exec'), namespace)
