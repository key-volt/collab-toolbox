import { expect, test } from 'vitest'

import { conflictName, parentOf, pathError } from './paths'

test('ordinary nested paths are accepted', () => {
  expect(pathError('main.py')).toBeNull()
  expect(pathError('src/deep/util_2.py')).toBeNull()
  expect(pathError('docs', { folder: true })).toBeNull()
})

test('the rules the server enforces are refused up front', () => {
  expect(pathError('')).not.toBeNull()
  expect(pathError('../escape.py')).not.toBeNull()
  expect(pathError('.hidden/x.py')).not.toBeNull()
  expect(pathError('a//b.py')).not.toBeNull()
  expect(pathError('a/' + 'b/'.repeat(9) + 'x.py')).not.toBeNull()
  expect(pathError('x'.repeat(65) + '.py')).not.toBeNull()
})

test('folders allow one level less than files', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `d${String(i)}`).join('/')
  expect(pathError(eight, { folder: true })).toBeNull()
  expect(pathError(`${eight}/more`, { folder: true })).not.toBeNull()
  expect(pathError(`${eight}/file.py`)).toBeNull()
})

test('conflict names stay in the same folder and keep the extension', () => {
  expect(conflictName('src/main.py', 'abcd1234')).toBe('src/main-conflict-abcd.py')
  expect(conflictName('Makefile', 'abcd1234')).toBe('Makefile-conflict-abcd')
  expect(parentOf('src/main.py')).toBe('src')
  expect(parentOf('main.py')).toBe('')
})
