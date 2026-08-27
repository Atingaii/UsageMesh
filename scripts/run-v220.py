from pathlib import Path

path = Path('scripts/apply-v220.py')
source = path.read_text()
source = source.replace(
    '        bail!(\\"dashboard password must be at least 8 bytes long\\")\\n    }',
    '        bail!(\\"dashboard password must be at least 8 bytes long\\");\\n    }',
)
namespace = {'__name__': '__main__', '__file__': str(path)}
exec(compile(source, str(path), 'exec'), namespace)
