import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('platform_lock', pathlib.Path(__file__).with_name('platform-lock.py'))
lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lock)


class PlatformLockTests(unittest.TestCase):
    def test_source_is_exact_and_never_a_production_dependency(self):
        config = {'developmentSource': {'repository': 'dispatch-core', 'commit': 'a' * 40}}
        self.assertEqual(lock.resolve(config)['mode'], 'source')
        with self.assertRaisesRegex(ValueError, 'published Core'):
            lock.resolve(config, production=True)
        config['developmentSource']['commit'] = 'main'
        with self.assertRaises(ValueError):
            lock.resolve(config)

    def test_release_needs_both_https_and_digest(self):
        config = {'url': 'https://example.com/package.tar.gz', 'sha256': 'a' * 64}
        self.assertEqual(lock.resolve(config, production=True), {'mode': 'release'})
        for changes in ({'url': 'http://example.com/package'}, {'sha256': None}, {'url': 'https://user:secret@example.com/package'}):
            with self.assertRaises(ValueError):
                lock.resolve({**config, **changes})

    def test_bad_release_does_not_fall_back_to_source(self):
        with self.assertRaises(ValueError):
            lock.resolve({'url': 'https://example.com/package', 'sha256': None,
                          'developmentSource': {'repository': 'dispatch-core', 'commit': 'a' * 40}})


if __name__ == '__main__':
    unittest.main()
